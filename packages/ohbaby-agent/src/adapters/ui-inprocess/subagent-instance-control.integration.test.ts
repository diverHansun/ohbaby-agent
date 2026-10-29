import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  LLMClientInstance,
} from "ohbaby-llm";
import type {
  UiEvent,
  UiPermissionRequest,
  UiPromptReceipt,
  UiSubagentInstance,
} from "ohbaby-sdk";
import { AgentManager } from "../../agents/manager.js";
import { AgentRegistry } from "../../agents/registry.js";
import { InMemorySubagentInstanceStore } from "../../agents/subagents/in-memory-store.js";
import { InMemorySubagentExecutionStore } from "../../agents/subagents/execution-store.js";
import { createSubagentMonitor } from "../../agents/subagents/monitor.js";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  type MessageManager,
} from "../../core/message/index.js";
import { createInMemorySessionManager } from "../../services/session/index.js";
import {
  createInProcessUiBackendClient,
  type InProcessUiBackendClient,
} from "../ui-inprocess.js";
import { createHostLocalSandboxManager } from "../ui-runtime/host-local-environment.js";
import type { SandboxLease } from "../../sandbox/index.js";

type Response = AsyncGenerator<InterfaceProviderStreamEvent>;
interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}
interface Fixture {
  client: InProcessUiBackendClient;
  directory: string;
  instances: InMemorySubagentInstanceStore;
  executions: InMemorySubagentExecutionStore;
  messages: MessageManager;
  parents: InterfaceProviderRequest[];
  events: UiEvent[];
  submit(calls: readonly ToolCall[]): Promise<UiPromptReceipt>;
  row(name: string): Promise<UiSubagentInstance>;
  dispose(): Promise<void>;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function response(event: InterfaceProviderStreamEvent): Response {
  return (async function* (): Response {
    yield await Promise.resolve(event);
  })();
}
function text(value: string): Response {
  return response({ textDelta: value, finishReason: "stop" });
}
function toolCalls(calls: readonly ToolCall[], id: number): Response {
  return response({
    finishReason: "tool_calls",
    toolCallDeltas: calls.map((call, index) => ({
      index,
      id: `call_${String(id)}_${String(index)}`,
      name: call.name,
      argumentsDelta: JSON.stringify(call.input),
    })),
  });
}
function held(
  request: InterfaceProviderRequest,
  gate: Promise<void>,
  value: string,
): Response {
  return (async function* (): Response {
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        reject(new DOMException("Stopped", "AbortError"));
      };
      if (request.signal?.aborted) {
        abort();
        return;
      }
      request.signal?.addEventListener("abort", abort, { once: true });
      void gate.then(() => {
        request.signal?.removeEventListener("abort", abort);
        resolve();
      });
    });
    yield { textDelta: value, finishReason: "stop" };
  })();
}
function spawn(
  name: string,
  mode: "foreground" | "background" = "background",
): ToolCall {
  return {
    name: "agent",
    input: {
      action: "spawn",
      name,
      role: "generic",
      prompt: `TASK_${name}`,
      mode,
    },
  };
}
async function eventually(
  assertion: () => void | Promise<void>,
): Promise<void> {
  await vi.waitFor(assertion, { timeout: 4000, interval: 10 });
}
function required(value: string | undefined): string {
  if (!value) throw new Error("Expected execution identity");
  return value;
}

async function fixture(
  child: (request: InterfaceProviderRequest) => Response,
  retainedRelease?: { entered: () => void; gate: Promise<void> },
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-instance-control-"));
  const bus = createBus();
  const messages = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
  });
  let sessionSequence = 0;
  const sessionManager = createInMemorySessionManager({
    bus,
    messageCleaner: messages,
    createSessionId: () =>
      sessionSequence++ === 0 ? "root" : `child_${String(sessionSequence)}`,
  });
  const root = await sessionManager.create(directory, {
    agentName: "main",
    title: "Root",
  });
  const instances = new InMemorySubagentInstanceStore();
  const executions = new InMemorySubagentExecutionStore();
  const sandbox = createHostLocalSandboxManager(directory);
  const sandboxManager = retainedRelease
    ? {
        ...sandbox,
        async acquire(
          input: Parameters<typeof sandbox.acquire>[0],
        ): Promise<SandboxLease> {
          const lease = await sandbox.acquire(input);
          if (lease.sessionId === "root") return lease;
          return {
            ...lease,
            retain: () => {
              const release = lease.retain?.();
              return async (): Promise<void> => {
                retainedRelease.entered();
                await retainedRelease.gate;
                await release?.();
              };
            },
          };
        },
      }
    : sandbox;
  let nextCalls: readonly ToolCall[] = [];
  let sequence = 0;
  const parents: InterfaceProviderRequest[] = [];
  const llmClient: LLMClientInstance = {
    config: {
      provider: "fake",
      model: "fake",
      apiKeyEnv: "FAKE_KEY",
      baseUrl: "https://example.invalid",
      interfaceProvider: "openai-compatible",
      maxTokens: 128,
      temperature: 0,
    },
    provider: {
      client: {},
      id: "fake",
      kind: "openai-compatible",
      isAbortError: (error) =>
        error instanceof Error && error.name === "AbortError",
      streamResponse(request) {
        const prompt = JSON.stringify(request.messages);
        if (prompt.includes("Write a short conversation title"))
          return Promise.resolve(text("Root"));
        if (prompt.includes("You are a focused subagent"))
          return Promise.resolve(child(request));
        parents.push(request);
        const calls = nextCalls;
        nextCalls = [];
        return Promise.resolve(
          calls.length ? toolCalls(calls, ++sequence) : text("parent complete"),
        );
      },
    },
  };
  const client = createInProcessUiBackendClient({
    bus,
    llmClient,
    messageManager: messages,
    sessionManager,
    sandboxManager,
    subagentInstanceStore: instances,
    subagentExecutionStore: executions,
    workdir: directory,
    projectDirectory: directory,
    agentManager: new AgentManager({
      registry: new AgentRegistry({
        configLoader: (): { agents: Record<string, never> } => ({ agents: {} }),
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
            tools: { include: ["read", "bash"] },
          },
        ],
      }),
    }),
    initialSnapshot: {
      activeSessionId: root.id,
      sessions: [
        {
          id: root.id,
          title: root.title,
          workingDirectory: directory,
          createdAt: new Date(root.createdAt).toISOString(),
          updatedAt: new Date(root.updatedAt).toISOString(),
          messages: [],
        },
      ],
      runs: [],
      permissions: [],
      status: { kind: "idle" },
    },
  });
  const events: UiEvent[] = [];
  const unsubscribe = client.subscribeEvents((event) => {
    events.push(event);
  });
  return {
    client,
    directory,
    instances,
    executions,
    messages,
    parents,
    events,
    submit(calls: readonly ToolCall[]): Promise<UiPromptReceipt> {
      nextCalls = calls;
      return client.submitPromptAccepted("Perform the requested operation", {
        sessionId: "root",
      });
    },
    async row(name: string): Promise<UiSubagentInstance> {
      const snapshot = await client.listSubagentInstances({
        rootSessionId: "root",
      });
      const row = snapshot.instances.find((item) => item.displayName === name);
      if (!row) throw new Error(`Missing child ${name}`);
      return row;
    },
    async dispose(): Promise<void> {
      unsubscribe();
      await client.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("actual in-process subagent instance control", () => {
  it.each(["background", "foreground"] as const)(
    "stops one child while the parent is %s without aborting the parent or sibling",
    async (mode) => {
      const gate = deferred();
      const children = new Map<string, InterfaceProviderRequest>();
      const f = await fixture((request) => {
        const name = JSON.stringify(request.messages).includes("TASK_A")
          ? "A"
          : "B";
        children.set(name, request);
        return held(request, gate.promise, `${name} complete`);
      });
      try {
        const receipt = await f.submit([spawn("A", mode), spawn("B")]);
        await eventually(() => {
          expect(children.size).toBe(2);
        });
        if (mode === "background")
          expect(
            (await f.client.waitForPrompt(receipt.promptId)).prompt.status,
          ).toBe("succeeded");
        const a = await f.row("A");
        const stopped = await f.client.stopSubagent({
          rootSessionId: "root",
          subagentId: a.subagentId,
          expectedExecutionId: required(a.currentExecutionId),
        });
        expect(["accepted", "confirmed"]).toContain(stopped.outcome);
        await eventually(async () => {
          expect((await f.row("A")).status).toBe("interrupted");
        });
        expect((await f.row("B")).status).toBe("running");
        expect(children.get("A")?.signal?.aborted).toBe(true);
        expect(children.get("B")?.signal?.aborted).toBe(false);
        expect(f.parents[0]?.signal?.aborted).toBe(false);
        expect(
          (await f.client.waitForPrompt(receipt.promptId)).prompt.status,
        ).toBe("succeeded");
      } finally {
        gate.resolve();
        await f.dispose();
      }
    },
  );

  it("does not stop a later execution when an old stop request arrives", async () => {
    const gate = deferred();
    const children: InterfaceProviderRequest[] = [];
    const f = await fixture((request) => {
      children.push(request);
      return held(request, gate.promise, "complete");
    });
    try {
      const initial = await f.submit([spawn("A")]);
      await f.client.waitForPrompt(initial.promptId);
      await eventually(() => {
        expect(children).toHaveLength(1);
      });
      const old = await f.row("A");
      const input = {
        rootSessionId: "root",
        subagentId: old.subagentId,
        expectedExecutionId: required(old.currentExecutionId),
      };
      await f.client.stopSubagent(input);
      await eventually(async () => {
        expect((await f.row("A")).currentExecutionId).toBeUndefined();
      });
      const followup = await f.submit([
        {
          name: "agent",
          input: {
            action: "send",
            agent_id: old.subagentId,
            message: "TASK_A_FOLLOWUP",
            mode: "background",
          },
        },
      ]);
      await f.client.waitForPrompt(followup.promptId);
      await eventually(() => {
        expect(children).toHaveLength(2);
      });
      const latest = await f.row("A");
      expect(latest.currentExecutionId).not.toBe(old.currentExecutionId);
      expect(await f.client.stopSubagent(input)).toMatchObject({
        outcome: "execution_changed",
        instance: {
          currentExecutionId: latest.currentExecutionId,
          status: "running",
        },
      });
      expect(children[1]?.signal?.aborted).toBe(false);
    } finally {
      gate.resolve();
      await f.dispose();
    }
  });

  it("releases a closed instance's UI watch while retaining saved monitor history", async () => {
    const f = await fixture(() => text("SAVED-CHILD-RESULT"));
    try {
      const receipt = await f.submit([spawn("A", "foreground")]);
      await f.client.waitForPrompt(receipt.promptId);
      const a = await f.row("A");
      const query = { rootSessionId: "root", subagentId: a.subagentId };
      await f.client.retainSubagentConversation({
        ...query,
        watchId: "watch-a",
      });
      const closed = await f.submit([
        { name: "agent", input: { action: "close", agent_id: a.subagentId } },
      ]);
      await f.client.waitForPrompt(closed.promptId);
      expect(
        (await f.client.listSubagentInstances({ rootSessionId: "root" }))
          .instances,
      ).toEqual([]);
      await expect(
        f.client.getSubagentConversationView(query),
      ).rejects.toMatchObject({ code: "SUBAGENT_CLOSED" });
      await expect(
        f.client.retainSubagentConversation({ ...query, watchId: "new-watch" }),
      ).rejects.toMatchObject({ code: "SUBAGENT_CLOSED" });
      expect(f.events).toContainEqual(
        expect.objectContaining({
          type: "subagent.conversation.unavailable",
          subagentId: a.subagentId,
          code: "SUBAGENT_CLOSED",
        }),
      );
      const monitor = createSubagentMonitor({
        instances: f.instances,
        executions: f.executions,
        messages: f.messages,
      });
      const history = await monitor({
        parentSessionId: "root",
        subagentIds: [a.subagentId],
      });
      expect(history.targets[0]?.item?.closedAt).toEqual(expect.any(Number));
      expect(history.targets[0]?.error).toBeUndefined();
      expect(JSON.stringify(history.targets[0]?.records)).toContain(
        "SAVED-CHILD-RESULT",
      );
    } finally {
      await f.dispose();
    }
  });

  it("invalidates the instance snapshot when late resource release clears settling", async () => {
    const released = deferred();
    const entered = deferred();
    const childGate = deferred();
    let childStep = 0;
    const f = await fixture(
      (request) =>
        childStep++ === 0
          ? toolCalls(
              [{ name: "read", input: { file_path: "source.txt" } }],
              900,
            )
          : held(request, childGate.promise, "child complete"),
      {
        entered: () => {
          entered.resolve();
        },
        gate: released.promise,
      },
    );
    try {
      await writeFile(join(f.directory, "source.txt"), "source content");
      const receipt = await f.submit([spawn("A")]);
      await f.client.waitForPrompt(receipt.promptId);
      await entered.promise;
      const a = await f.row("A");
      const stopped = await f.client.stopSubagent({
        rootSessionId: "root",
        subagentId: a.subagentId,
        expectedExecutionId: required(a.currentExecutionId),
      });
      expect(stopped).toMatchObject({
        outcome: "accepted",
        instance: { settling: true, currentExecutionId: a.currentExecutionId },
      });
      const before = await f.client.listSubagentInstances({
        rootSessionId: "root",
      });
      f.events.length = 0;
      released.resolve();
      await eventually(async () => {
        expect(await f.row("A")).toMatchObject({
          settling: false,
          currentExecutionId: undefined,
        });
      });
      const after = await f.client.listSubagentInstances({
        rootSessionId: "root",
      });
      expect(after.revision).toBeGreaterThan(before.revision);
      expect(f.events).toContainEqual(
        expect.objectContaining({
          type: "subagent.instances.invalidated",
          rootSessionId: "root",
          revision: after.revision,
        }),
      );
    } finally {
      released.resolve();
      childGate.resolve();
      await f.dispose();
    }
  });

  it("publishes a late child persistence failure after the original parent prompt has completed", async () => {
    const gate = deferred();
    const f = await fixture((request) =>
      held(request, gate.promise, "child saved output"),
    );
    const finish = vi.spyOn(f.executions, "finish");
    try {
      const receipt = await f.submit([spawn("A")]);
      expect(
        (await f.client.waitForPrompt(receipt.promptId)).prompt.status,
      ).toBe("succeeded");
      await eventually(async () => {
        expect((await f.row("A")).status).toBe("running");
      });
      // The child completes through the real Host after its parent's run has ended.
      finish.mockRejectedValueOnce(new Error("late child ledger write failed"));
      f.events.length = 0;
      gate.resolve();
      await eventually(() => {
        expect(
          f.events.find(
            (event) =>
              event.type === "notice.emitted" &&
              event.notice.title === "Subagent result persistence failed",
          ),
        ).toMatchObject({
          type: "notice.emitted",
          notice: {
            level: "error",
            title: "Subagent result persistence failed",
            message: "late child ledger write failed",
          },
        });
      });
      expect(
        (await f.client.waitForPrompt(receipt.promptId)).prompt.status,
      ).toBe("succeeded");
    } finally {
      finish.mockRestore();
      gate.resolve();
      await f.dispose();
    }
  });

  it("allows a background child to start a new bash approval after its parent has completed", async () => {
    const gate = deferred();
    let childStep = 0;
    const f = await fixture((request) => {
      if (childStep++ > 0) return text("bash completed");
      return (async function* (): Response {
        // Delay the first child operation until the original parent has ended.
        for await (const _ of held(request, gate.promise, "")) {
          /* wait only */
        }
        yield* toolCalls(
          [
            {
              name: "bash",
              input: {
                command:
                  "node -e \"require('node:fs').writeFileSync('after-parent.txt','ran')\"",
              },
            },
          ],
          901,
        );
      })();
    });
    const approval = deferred<UiPermissionRequest>();
    const unsubscribe = f.client.subscribePermissionEvents((event) => {
      if (event.type === "permission.requested")
        approval.resolve(event.request);
    });
    try {
      const receipt = await f.submit([spawn("A")]);
      expect(
        (await f.client.waitForPrompt(receipt.promptId)).prompt.status,
      ).toBe("succeeded");
      const a = await f.row("A");
      gate.resolve();
      const request = await approval.promise;
      expect(request.rootSessionId).toBe("root");
      expect(request.sessionId).not.toBe("root");
      await eventually(async () => {
        expect(await f.row("A")).toMatchObject({
          approvalBlocked: true,
          status: "running",
        });
      });
      const snapshot = await f.client.getPermissionSnapshot({
        rootSessionId: "root",
      });
      await f.client.respondPermission(
        request.id,
        { choiceId: "allow_once" },
        { rootSessionId: "root", permissionEpoch: snapshot.permissionEpoch },
      );
      await eventually(async () => {
        expect(await f.row("A")).toMatchObject({
          status: "completed",
          approvalBlocked: false,
          subagentId: a.subagentId,
        });
      });
      expect(
        await readFile(join(f.directory, "after-parent.txt"), "utf8"),
      ).toBe("ran");
      expect(
        (await f.client.waitForPrompt(receipt.promptId)).prompt.status,
      ).toBe("succeeded");
    } finally {
      unsubscribe();
      gate.resolve();
      await f.dispose();
    }
  });
});
