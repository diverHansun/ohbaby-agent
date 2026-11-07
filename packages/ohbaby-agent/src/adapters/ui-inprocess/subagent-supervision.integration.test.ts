import { describe, expect, it, vi } from "vitest";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  LLMClientInstance,
} from "ohbaby-llm";
import {
  createInProcessUiBackendClient,
  type InProcessUiBackendClient,
} from "../ui-inprocess.js";
import { InMemorySubagentExecutionStore } from "../../agents/subagents/execution-store.js";
import { AgentManager } from "../../agents/manager.js";
import { AgentRegistry } from "../../agents/registry.js";

function stream(
  ...events: InterfaceProviderStreamEvent[]
): AsyncGenerator<InterfaceProviderStreamEvent> {
  return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
    for (const event of events) yield await Promise.resolve(event);
  })();
}
function text(value: string): AsyncGenerator<InterfaceProviderStreamEvent> {
  return stream({ textDelta: value, finishReason: "stop" });
}
function tool(
  ...calls: { name: string; input: unknown }[]
): AsyncGenerator<InterfaceProviderStreamEvent> {
  return stream({
    toolCallDeltas: calls.map((call, index) => ({
      index,
      id: `call_${String(index)}`,
      name: call.name,
      argumentsDelta: JSON.stringify(call.input),
    })),
    finishReason: "tool_calls",
  });
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitForGate(
  request: InterfaceProviderRequest,
  gate: Promise<void>,
): Promise<void> {
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
}
function held(
  request: InterfaceProviderRequest,
  gate: Promise<void>,
  result: string,
): AsyncGenerator<InterfaceProviderStreamEvent> {
  return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
    await waitForGate(request, gate);
    yield { textDelta: result, finishReason: "stop" };
  })();
}

function createFixture(
  respond: (
    request: InterfaceProviderRequest,
    child: boolean,
  ) => AsyncGenerator<InterfaceProviderStreamEvent>,
): {
  client: InProcessUiBackendClient;
  executions: InMemorySubagentExecutionStore;
} {
  const executions = new InMemorySubagentExecutionStore();
  const llm: LLMClientInstance<{ kind: "fake" }> = {
    config: {
      provider: "fake",
      model: "fake",
      apiKeyEnv: "FAKE_KEY",
      baseUrl: "https://example.invalid",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 128,
    },
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      isAbortError: (error) =>
        error instanceof Error && error.name === "AbortError",
      streamResponse: (request) => {
        const prompt = JSON.stringify(request.messages);
        return Promise.resolve(
          prompt.includes("Write a short conversation title")
            ? text("Background tasks")
            : respond(request, prompt.includes("You are a focused subagent")),
        );
      },
    },
  };
  const client = createInProcessUiBackendClient({
    llmClient: llm,
    subagentExecutionStore: executions,
    agentManager: new AgentManager({
      registry: new AgentRegistry({
        configLoader: (): { agents: Record<string, never> } => ({ agents: {} }),
        builtinAgents: [
          {
            name: "main",
            description: "Main",
            mode: "primary",
            default: true,
            tools: { include: ["agent", "UpdateGoal", "SetGoalBudget"] },
          },
          {
            name: "generic",
            description: "Child",
            mode: "subagent",
            tools: { include: ["write", "read"] },
          },
        ],
      }),
    }),
  });
  return { client, executions };
}
async function eventually(
  assertion: () => void | Promise<void>,
): Promise<void> {
  await vi.waitFor(assertion, { interval: 1, timeout: 1500 });
}
async function idle(f: ReturnType<typeof createFixture>): Promise<void> {
  await eventually(async () => {
    expect(
      (await f.client.getSessionControl({ sessionId: "session_1" })).driver,
    ).toBeNull();
  });
  await vi.advanceTimersByTimeAsync(0);
}
const spawn = {
  name: "agent",
  input: {
    action: "spawn",
    prompt: "Complete the independent task",
    role: "generic",
    mode: "background",
  },
};

describe("session subagent supervision integration", () => {
  it("keeps ordinary results eligible after its session Goal exhausts budget", async () => {
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
      ],
    });
    const ordinary = deferred();
    const goalChild = deferred();
    const goalChildStarted = deferred();
    const parents: InterfaceProviderRequest[] = [];
    const children: InterfaceProviderRequest[] = [];
    const f = createFixture((request, child) => {
      if (child) {
        children.push(request);
        if (children.length === 2) goalChildStarted.resolve();
        return held(
          request,
          children.length === 1 ? ordinary.promise : goalChild.promise,
          children.length === 1 ? "ORDINARY-RESULT" : "GOAL-RESULT",
        );
      }
      parents.push(request);
      if (parents.length === 1) return tool(spawn);
      if (parents.length === 3)
        return tool(spawn, {
          name: "SetGoalBudget",
          input: { unit: "turns", value: 1 },
        });
      if (parents.length === 4)
        return held(request, goalChildStarted.promise, "Goal round ended");
      return text("Main round ended");
    });
    try {
      const initial = f.client.submitPromptAndWait(
        "Start ordinary background work",
      );
      await eventually(() => {
        expect(parents).toHaveLength(2);
      });
      await initial;
      await eventually(() => {
        expect(children).toHaveLength(1);
      });
      await f.client.executeCommand({
        argv: ["Goal task"],
        clientInvocationId: "goal",
        commandId: "goal",
        path: ["goal"],
        raw: "/goal Goal task",
        rawArgs: "Goal task",
        sessionId: "session_1",
        surface: "tui",
      });
      await eventually(async () => {
        expect((await f.client.getSnapshot()).goals?.[0]?.goal).toMatchObject({
          status: "blocked",
          turnsUsed: 1,
        });
        expect(children).toHaveLength(2);
        expect(children[1]?.signal?.aborted).toBe(true);
      });
      expect(children[0]?.signal?.aborted).toBe(false);
      const goalExecution = (
        await f.executions.list({ rootSessionId: "session_1" })
      ).find((record) => record.status === "interrupted");
      if (!goalExecution) throw new Error("Missing budget-owned child");
      // A terminal commit can arrive after budget cleanup; retain that durable result.
      const late = await f.executions.accept({
        ...goalExecution,
        executionId: "late-goal-result",
        requestId: "late-goal-call",
        createdAt: Date.now(),
      });
      await f.executions.finish(late.record, {
        status: "completed",
        output: "BUDGET-FENCED-GOAL-RESULT",
        completedAt: Date.now(),
      });
      await idle(f);
      await vi.advanceTimersByTimeAsync(7 * 60_000);
      expect(parents).toHaveLength(4);
      const resultIndex = 4;
      ordinary.resolve();
      await eventually(async () => {
        expect(parents).toHaveLength(resultIndex + 1);
        const ordinaryResult = (
          await f.executions.list({ rootSessionId: "session_1" })
        ).find((record) => record.output === "ORDINARY-RESULT");
        expect(ordinaryResult?.delivery.state).toBe("processed");
      });
      expect(JSON.stringify(parents[resultIndex]?.messages)).toContain(
        "ORDINARY-RESULT",
      );
      expect(JSON.stringify(parents[resultIndex]?.messages)).not.toContain(
        "BUDGET-FENCED-GOAL-RESULT",
      );
      expect((await f.executions.get(late.record))?.delivery.state).toBe(
        "pending",
      );
      const manual = f.client.submitPromptAndWait(
        "Review saved results without resuming the Goal",
        { sessionId: "session_1" },
      );
      await eventually(() => {
        expect(parents).toHaveLength(resultIndex + 2);
      });
      await manual;
      expect(JSON.stringify(parents[resultIndex + 1]?.messages)).toContain(
        "BUDGET-FENCED-GOAL-RESULT",
      );
      expect((await f.executions.get(late.record))?.delivery.state).toBe(
        "processed",
      );
      expect((await f.client.getSnapshot()).goals?.[0]?.goal).toMatchObject({
        status: "blocked",
        turnsUsed: 1,
      });
    } finally {
      ordinary.resolve();
      goalChild.resolve();
      await f.client.dispose();
      vi.useRealTimers();
    }
  });
  it("delivers two terminal results in the next request of the busy user run", async () => {
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
      ],
    });
    const first = deferred();
    const second = deferred();
    const user = deferred();
    const parents: InterfaceProviderRequest[] = [];
    let children = 0;
    let active = 0;
    let maximumActive = 0;
    const f = createFixture((request, child) => {
      if (child)
        return held(
          request,
          ++children === 1 ? first.promise : second.promise,
          `CHILD-${String(children)}-RESULT`,
        );
      parents.push(request);
      const round = parents.length;
      return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
        active++;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (round === 1) yield* tool(spawn, spawn);
          else if (round === 3) {
            await user.promise;
            yield* tool({ name: "agent", input: { action: "list" } });
          } else yield* text("Reviewed task");
        } finally {
          active--;
        }
      })();
    });
    try {
      const initial = f.client.submitPromptAndWait("Start both children");
      await eventually(() => {
        expect(parents).toHaveLength(2);
      });
      await initial;
      await vi.advanceTimersByTimeAsync(0);
      await eventually(() => {
        expect(children).toBe(2);
      });
      await vi.advanceTimersByTimeAsync(119_000);
      const incoming = f.client.submitPromptAndWait(
        "User guidance wins admission",
        { sessionId: "session_1" },
      );
      await eventually(() => {
        expect(parents).toHaveLength(3);
      });
      const busyRuns = (await f.client.getSnapshot()).runs.length;
      first.resolve();
      second.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      await eventually(async () => {
        expect(
          (await f.executions.list({ rootSessionId: "session_1" })).every(
            (record) => record.status === "completed",
          ),
        ).toBe(true);
      });
      expect(parents).toHaveLength(3);
      user.resolve();
      await incoming;
      await vi.advanceTimersByTimeAsync(0);
      expect((await f.client.getSnapshot()).runs).toHaveLength(busyRuns);
      expect(maximumActive).toBe(1);
      expect(parents).toHaveLength(4);
      const input = JSON.stringify(parents[3]?.messages);
      expect(input).toContain("CHILD-1-RESULT");
      expect(input).toContain("CHILD-2-RESULT");
      expect(
        (await f.executions.list({ rootSessionId: "session_1" })).every(
          (record) => record.delivery.state === "processed",
        ),
      ).toBe(true);
    } finally {
      first.resolve();
      second.resolve();
      user.resolve();
      await f.client.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["completed", "failed", "timed_out"] as const)(
    "leaves a running child alone, then wakes the idle parent once for %s",
    async (status) => {
      vi.useFakeTimers({
        toFake: [
          "Date",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
        ],
      });
      const childGate = deferred();
      const parents: InterfaceProviderRequest[] = [];
      let childSignal: AbortSignal | undefined;
      const f = createFixture((request, child) => {
        if (child) {
          childSignal = request.signal;
          return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            await waitForGate(request, childGate.promise);
            if (status === "failed") throw new Error("Child operation failed");
            yield* text("CHILD-RESULT");
          })();
        }
        parents.push(request);
        return parents.length === 1 ? tool(spawn) : text("Main round ended");
      });
      try {
        await f.client.submitPromptAndWait("Start long running child");
        await idle(f);
        const startedAt = (
          await f.executions.list({ rootSessionId: "session_1" })
        )[0]?.startedAt;
        if (startedAt === undefined)
          throw new Error("Missing child start timestamp");
        const runCount = (await f.client.getSnapshot()).runs.length;
        for (const minutes of [2, 5, 5]) {
          await vi.advanceTimersByTimeAsync(minutes * 60_000);
          expect(parents).toHaveLength(2);
          expect((await f.client.getSnapshot()).runs).toHaveLength(runCount);
        }
        if (status === "timed_out") {
          await vi.advanceTimersByTimeAsync(
            startedAt + 30 * 60_000 - Date.now() - 1,
          );
          expect(childSignal?.aborted).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(childSignal?.aborted).toBe(true);
        } else childGate.resolve();
        await eventually(async () => {
          expect(
            await f.executions.list({ rootSessionId: "session_1" }),
          ).toMatchObject([{ status, delivery: { state: "processed" } }]);
        });
        await idle(f);
        expect(JSON.stringify(parents[2]?.messages)).toContain(status);
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(parents).toHaveLength(3);
        expect((await f.client.getSnapshot()).runs).toHaveLength(runCount + 1);
      } finally {
        childGate.resolve();
        await f.client.dispose();
        vi.useRealTimers();
      }
    },
  );
  it("excludes real child approval waiting from the Host active-time deadline", async () => {
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
      ],
    });
    const childGate = deferred();
    const parents: InterfaceProviderRequest[] = [];
    let childRequests = 0;
    let childSignal: AbortSignal | undefined;
    const f = createFixture((request, child) => {
      if (child) {
        childSignal = request.signal;
        if (++childRequests === 1)
          return tool({
            name: "write",
            input: {
              file_path: "approval-test.txt",
              content: "test",
              dry_run: true,
            },
          });
        return held(request, childGate.promise, "never");
      }
      parents.push(request);
      return parents.length === 1 ? tool(spawn) : text("Review saved facts");
    });
    try {
      const initial = f.client.submitPromptAndWait(
        "Start child requiring approval",
      );
      await eventually(() => {
        expect(parents).toHaveLength(2);
      });
      await initial;
      let permissionId: string | undefined;
      await eventually(async () => {
        permissionId = (await f.client.getSnapshot()).permissions[0]?.id;
        expect(permissionId).toBeDefined();
      });
      await vi.advanceTimersByTimeAsync(35 * 60_000);
      expect(childSignal?.aborted).toBe(false);
      expect(parents).toHaveLength(2);
      expect(
        (await f.executions.list({ rootSessionId: "session_1" }))[0]?.status,
      ).toBe("running");
      if (!permissionId) throw new Error("Missing child approval");
      await f.client.respondPermission(permissionId, { choiceId: "reject" });
      await eventually(() => {
        expect(childRequests).toBe(2);
      });
      const resumedAt = Date.now();
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      expect(childSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(resumedAt + 30 * 60_000 - Date.now());
      await eventually(async () => {
        expect(
          (await f.executions.list({ rootSessionId: "session_1" }))[0]?.status,
        ).toBe("timed_out");
      });
      expect(childSignal?.aborted).toBe(true);
      await eventually(async () => {
        expect(
          (await f.executions.list({ rootSessionId: "session_1" }))[0]?.delivery
            .state,
        ).toBe("processed");
      });
      expect(JSON.stringify(parents.at(-1)?.messages)).toContain("timed_out");
    } finally {
      childGate.resolve();
      await f.client.dispose();
      vi.useRealTimers();
    }
  });
});
