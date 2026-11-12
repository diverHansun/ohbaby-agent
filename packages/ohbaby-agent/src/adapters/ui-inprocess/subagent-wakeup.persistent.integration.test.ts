import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  LLMClientInstance,
} from "ohbaby-llm";
import { AgentManager } from "../../agents/manager.js";
import { AgentRegistry } from "../../agents/registry.js";
import { DatabaseSubagentExecutionStore } from "../../agents/subagents/execution-store.js";
import { closeDatabase, getDatabase } from "../../services/database/index.js";
import { createPersistentUiBackendClient } from "../ui-persistent.js";
import { DatabaseCurrentRunInputStore } from "../../runtime/prompt-scheduler/current-run-inputs.js";

function stream(
  events: InterfaceProviderStreamEvent[],
): AsyncGenerator<InterfaceProviderStreamEvent> {
  return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
    for (const event of events) yield await Promise.resolve(event);
  })();
}

it.each([
  { historicalMessage: false, entranceFailures: 0, stopAt: "none" },
  { historicalMessage: true, entranceFailures: 0, stopAt: "none" },
  { historicalMessage: true, entranceFailures: 1, stopAt: "none" },
  { historicalMessage: true, entranceFailures: 0, stopAt: "before-run" },
  { historicalMessage: true, entranceFailures: 0, stopAt: "after-run" },
  { historicalMessage: true, entranceFailures: 0, stopAt: "shutdown" },
])(
  "delivers with historical ID=$historicalMessage, entrance failures=$entranceFailures, Stop=$stopAt",
  async ({ historicalMessage, entranceFailures, stopAt }) => {
    const directory = await mkdtemp(join(tmpdir(), "subagent-delivery-"));
    const workdir = join(directory, "current-project");
    await mkdir(workdir);
    vi.stubEnv("OHBABY_HOME", join(directory, "home"));
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let releasePreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let preparing = false;
    const parentRequests: InterfaceProviderRequest[] = [];
    const llm: LLMClientInstance<{ kind: "fake" }> = {
      config: {
        provider: "fake",
        model: "fake-model",
        apiKeyEnv: "FAKE_API_KEY",
        baseUrl: "https://example.invalid/v1",
        interfaceProvider: "openai-compatible",
        temperature: 0,
        maxTokens: 128,
        modelProfiles: [
          {
            model: "fake-model",
            contextWindowTokens: 128000,
            reasoningCapabilities: {
              mode: "none",
              wire: "none",
              supportsDisabled: true,
            },
          },
        ],
      },
      provider: {
        id: "fake",
        kind: "openai-compatible",
        client: { kind: "fake" },
        isAbortError: () => false,
        async streamResponse(request) {
          await Promise.resolve();
          const prompt = JSON.stringify(request.messages);
          if (prompt.includes("Write a short conversation title"))
            return stream([
              { textDelta: "Background delivery", finishReason: "stop" },
            ]);
          if (prompt.includes("You are a focused subagent"))
            return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              await new Promise<void>((resolve, reject) => {
                void childGate.then(resolve);
                const abort = (): void => {
                  reject(new DOMException("Stopped", "AbortError"));
                };
                if (request.signal?.aborted) abort();
                else
                  request.signal?.addEventListener("abort", abort, {
                    once: true,
                  });
              });
              yield {
                textDelta: "CHILD-DELIVERY-RESULT",
                finishReason: "stop" as const,
              };
            })();
          parentRequests.push(request);
          if (parentRequests.length === 1)
            return stream([
              {
                toolCallDeltas: [
                  {
                    index: 0,
                    id: "dispatch",
                    name: "agent",
                    argumentsDelta: JSON.stringify({
                      action: "spawn",
                      role: "generic",
                      prompt: "Reply with the result",
                    }),
                  },
                ],
                finishReason: "tool_calls",
              },
            ]);
          return stream([
            {
              textDelta:
                parentRequests.length === 2
                  ? "Waiting for child"
                  : "Received child",
              finishReason: "stop",
            },
          ]);
        },
      },
    };
    const open = (): ReturnType<typeof createPersistentUiBackendClient> =>
      createPersistentUiBackendClient({
        dbPath: join(directory, "agent.db"),
        storageRoot: join(directory, "storage"),
        workdir,
        enableSnapshots: false,
        llmClient: llm,
        agentManager: new AgentManager({
          registry: new AgentRegistry({
            configLoader: (): { agents: Record<string, never> } => ({
              agents: {},
            }),
            builtinAgents: [
              {
                name: "main",
                description: "Main",
                mode: "primary",
                default: true,
                tools: { include: ["agent"] },
              },
              {
                name: "generic",
                description: "Child",
                mode: "subagent",
                tools: { include: [] },
              },
            ],
          }),
        }),
      });
    let client = open();
    try {
      await client.initialize();
      let db = getDatabase();
      if (historicalMessage) {
        db.prepare(
          "INSERT INTO session(id,project_id,working_directory,agent,title,status,created_at,updated_at,data) VALUES('historical','global',?,'main','old','active',1,1,'{}')",
        ).run(join(directory, "other-project"));
        db.prepare(
          "INSERT INTO message(id,session_id,role,agent,created_at,updated_at,data) VALUES('message_1','historical','user','main',1,1,?)",
        ).run(
          JSON.stringify({
            id: "message_1",
            sessionId: "historical",
            role: "user",
            agent: "main",
            time: { created: 1 },
          }),
        );
      }
      await client.submitPromptAndWait("Run a child");
      expect(parentRequests).toHaveLength(2);
      const initialSessionId = (await client.getSnapshot()).activeSessionId;
      assert(initialSessionId);
      if (stopAt === "shutdown") {
        const rootSessionId = (await client.getSnapshot()).activeSessionId;
        assert(rootSessionId);
        await client.dispose();
        expect(
          db.prepare("SELECT status,reason FROM subagent_execution").get(),
        ).toEqual({ status: "interrupted", reason: "service-shutdown" });
        expect(parentRequests).toHaveLength(2);
        closeDatabase();
        client = open();
        await client.initialize();
        db = getDatabase();
        await client.initializeSession(rootSessionId);
      }
      if (stopAt === "before-run") {
        // Borrow the prototype implementation; apply below restores its receiver.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const getAgent = AgentManager.prototype.getRuntimeAgent;
        vi.spyOn(AgentManager.prototype, "getRuntimeAgent").mockImplementation(
          async function (this: AgentManager, ...args) {
            if (!args[1]?.isSubagent && !preparing) {
              preparing = true;
              await preparationGate;
            }
            return getAgent.apply(this, args);
          },
        );
      }
      let failures = 0;
      // Borrow the implementation; call below restores the actual store receiver.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const accept = DatabaseCurrentRunInputStore.prototype.acceptRuntimeInput;
      vi.spyOn(
        DatabaseCurrentRunInputStore.prototype,
        "acceptRuntimeInput",
      ).mockImplementation(async function (
        this: DatabaseCurrentRunInputStore,
        input,
      ) {
        if (
          input.source === "subagent-status" &&
          stopAt === "after-run" &&
          !preparing
        ) {
          preparing = true;
          await preparationGate;
        }
        if (input.source === "subagent-status" && failures < entranceFailures) {
          failures++;
          return Promise.reject(new Error("Injected input admission failure"));
        }
        return accept.call(this, input);
      });
      releaseChild();
      if (stopAt === "before-run" || stopAt === "after-run") {
        await vi.waitFor(() => {
          expect(preparing).toBe(true);
        });
        const row = db
          .prepare<{
            delivery: string;
          }>("SELECT delivery FROM subagent_execution")
          .get();
        assert(row);
        const wakeRun = (JSON.parse(row.delivery) as { wakeupRunId: string })
          .wakeupRunId;
        const ledger = db
          .prepare("SELECT status FROM run_ledger WHERE run_id=?")
          .get(wakeRun);
        expect(ledger === undefined).toBe(stopAt === "before-run");
        await client.abortRun(wakeRun);
        releasePreparation();
        const sessionId = (await client.getSnapshot()).activeSessionId;
        assert(sessionId);
        await vi.waitFor(async () => {
          expect(
            (await client.getSessionControl?.({ sessionId }))?.driver,
          ).toBeNull();
        });
        expect(parentRequests).toHaveLength(2);
        const stopped = db
          .prepare<{
            delivery: string;
          }>("SELECT delivery FROM subagent_execution")
          .get();
        assert(stopped);
        expect(JSON.parse(stopped.delivery)).toMatchObject({
          wakeupRetriesRemaining: 0,
        });
        if (stopAt === "after-run")
          expect(
            db
              .prepare(
                "SELECT inputs_close_reason FROM run_ledger WHERE run_id=?",
              )
              .get(wakeRun),
          ).toEqual({ inputs_close_reason: "user-stop" });
        // A later user request can still consume the saved result.
        await client.submitPromptAndWait("Review the child result", {
          sessionId,
        });
      }
      await vi.waitFor(
        () => {
          expect(parentRequests).toHaveLength(3);
        },
        {
          timeout: 8_000,
        },
      );
      expect(failures).toBe(entranceFailures);
      expect(
        parentRequests,
        "child completion must reach the parent without another user input",
      ).toHaveLength(3);
      expect(JSON.stringify(parentRequests[2]?.messages)).toContain(
        stopAt === "shutdown" ? "service-shutdown" : "CHILD-DELIVERY-RESULT",
      );
      const rootSessionId = initialSessionId;
      const executions = new DatabaseSubagentExecutionStore({ db });
      await vi.waitFor(async () => {
        const results = await executions.list({
          rootSessionId,
        });
        expect(results).toHaveLength(1);
        expect(results[0]?.delivery.state).toBe("processed");
        expect(results[0]?.delivery.processedRequestId).toBeTruthy();
      });
      if (historicalMessage)
        expect(
          db
            .prepare("SELECT session_id FROM message WHERE id='message_1'")
            .get(),
        ).toEqual({ session_id: "historical" });
    } finally {
      releaseChild();
      releasePreparation();
      await client.dispose();
      closeDatabase();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);
