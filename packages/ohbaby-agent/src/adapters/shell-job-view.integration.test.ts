import { getDatabase } from "../services/database/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  InterfaceProviderStreamEvent,
  LLMClientInstance,
} from "ohbaby-llm";
import { createPersistentUiBackendClient } from "./ui-persistent.js";

describe("real persisted shell projections", () => {
  it("shows the latest child Bash fact in its view and history while preserving its original result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shell-child-projection-"));
    vi.stubEnv("OHBABY_HOME", dir);
    let mainStarted = false;
    let childStarted = false;
    const llm: LLMClientInstance = {
      config: {
        provider: "local",
        model: "fixture",
        interfaceProvider: "openai-compatible",
        baseUrl: "http://localhost.invalid",
        maxTokens: 256,
        contextWindowTokens: 128000,
      },
      provider: {
        id: "local",
        kind: "openai-compatible",
        client: {},
        isAbortError: () => false,
        streamResponse(request) {
          let call: { name: string; args: Record<string, unknown> } | undefined;
          if (request.purpose === "agent-step") {
            if (request.contextScopeId && !childStarted) {
              childStarted = true;
              call = {
                name: "bash",
                args: { command: "sleep 2", run_in_background: true },
              };
            } else if (!request.contextScopeId && !mainStarted) {
              mainStarted = true;
              call = {
                name: "agent",
                args: {
                  action: "spawn",
                  role: "generic",
                  name: "Projection child",
                  prompt: "Start a background shell.",
                },
              };
            }
          }
          return Promise.resolve(
            // eslint-disable-next-line @typescript-eslint/require-await
            (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              if (call)
                yield {
                  finishReason: "tool_calls",
                  toolCallDeltas: [
                    {
                      id: request.contextScopeId
                        ? "child-shell-call"
                        : "spawn-child-call",
                      index: 0,
                      name: call.name,
                      argumentsDelta: JSON.stringify(call.args),
                    },
                  ],
                };
              else yield { textDelta: "done", finishReason: "stop" };
            })(),
          );
        },
      },
    };
    const client = createPersistentUiBackendClient({
      dbPath: join(dir, "agent.db"),
      workdir: dir,
      llmClient: llm,
      enableSnapshots: false,
    });
    try {
      await client.setPermission({ level: "full-access" });
      const { prompt } = await client.submitPromptAndWait("Create a child");
      const root = prompt.sessionId;
      let subagentId = "";
      await vi.waitFor(
        async () => {
          const instances = await client.listSubagentInstances({
            rootSessionId: root,
          });
          subagentId = instances.instances[0]?.subagentId ?? "";
          expect(subagentId).not.toBe("");
          const jobs = await client.listShellJobs({ rootSessionId: root });
          expect(
            jobs.rows.some(
              (row) =>
                row.subagentId === subagentId && row.status !== "running",
            ),
          ).toBe(true);
        },
        { timeout: 10000 },
      );
      const conversation = await client.getSubagentConversationView({
        rootSessionId: root,
        subagentId,
      });
      const find = (messages: typeof conversation.messages) =>
        messages
          .flatMap((message) => message.parts)
          .filter(
            (part) =>
              part.type === "tool-result" &&
              part.result.details?.kind === "bash",
          );
      const raw = getDatabase()
        .prepare<{ data: string }>("SELECT data FROM part WHERE type = 'tool'")
        .all()
        .map(
          (row) =>
            JSON.parse(row.data) as {
              callId?: string;
              state?: { status?: string; metadata?: { status?: string } };
            },
        )
        .find((part) => part.callId === "child-shell-call");
      expect(raw?.state).toMatchObject({
        status: "completed",
        metadata: { status: "running" },
      });
      const history = find(conversation.messages);
      const live = find(conversation.view.session.messages);
      expect(history.length).toBeGreaterThan(0);
      expect(live.length).toBeGreaterThan(0);
      for (const part of [...history, ...live]) {
        if (part.type !== "tool-result" || part.result.details?.kind !== "bash")
          continue;
        expect(part.result.callId).toBe("child-shell-call");
        expect(part.result.details.status).not.toBe("running");
        expect(part.result.outputAvailable).toBe(true);
      }
    } finally {
      await client.dispose();
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);
  it("overlays a completed main job after the final persistent snapshot merge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shell-main-projection-"));
    vi.stubEnv("OHBABY_HOME", dir);
    let started = false;
    const llm: LLMClientInstance = {
      config: {
        provider: "local",
        model: "fixture",
        interfaceProvider: "openai-compatible",
        baseUrl: "http://localhost.invalid",
        maxTokens: 256,
        contextWindowTokens: 128000,
      },
      provider: {
        id: "local",
        kind: "openai-compatible",
        client: {},
        isAbortError: () => false,
        streamResponse(request) {
          const call = request.purpose === "agent-step" && !started;
          if (call) started = true;
          return Promise.resolve(
            // eslint-disable-next-line @typescript-eslint/require-await
            (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              if (call)
                yield {
                  finishReason: "tool_calls",
                  toolCallDeltas: [
                    {
                      id: "main-shell-call",
                      index: 0,
                      name: "bash",
                      argumentsDelta: JSON.stringify({
                        command: "sleep 0.2; echo done",
                        run_in_background: true,
                      }),
                    },
                  ],
                };
              else yield { textDelta: "done", finishReason: "stop" };
            })(),
          );
        },
      },
    };
    const client = createPersistentUiBackendClient({
      dbPath: join(dir, "agent.db"),
      workdir: dir,
      llmClient: llm,
      enableSnapshots: false,
    });
    try {
      await client.setPermission({ level: "full-access" });
      const { prompt } = await client.submitPromptAndWait("Run shell");
      const root = prompt.sessionId;
      await vi.waitFor(
        async () => {
          expect(
            (await client.listShellJobs({ rootSessionId: root })).rows[0]
              ?.status,
          ).toBe("completed");
        },
        { timeout: 5000 },
      );
      if (!client.getSessionView || !client.getSessionHistory)
        throw new Error("Persistent session read APIs are unavailable");
      const snapshot = await client.getSnapshot();
      const view = await client.getSessionView({ sessionId: root });
      const history = await client.getSessionHistory({ sessionId: root });
      const lists = [
        snapshot.sessions.find((session) => session.id === root)?.messages ??
          [],
        view.session.messages,
        history.messages,
      ];
      for (const messages of lists) {
        const part = messages
          .flatMap((message) => message.parts)
          .find(
            (item) =>
              item.type === "tool-result" &&
              item.result.callId === "main-shell-call",
          );
        expect(part).toMatchObject({
          result: {
            details: { kind: "bash", status: "completed", mode: "background" },
          },
        });
      }
      const raw = getDatabase()
        .prepare<{ data: string }>("SELECT data FROM part WHERE type = 'tool'")
        .all()
        .map(
          (row) =>
            JSON.parse(row.data) as {
              callId?: string;
              state?: { status?: string; metadata?: { status?: string } };
            },
        )
        .find((part) => part.callId === "main-shell-call");
      expect(raw?.state).toMatchObject({
        status: "completed",
        metadata: { status: "running" },
      });
    } finally {
      await client.dispose();
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);
});
