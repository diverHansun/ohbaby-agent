import { describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import { createPermissionState } from "../../permission/index.js";
import { createToolScheduler } from "./scheduler.js";
import { withToolAdmission } from "./tool-admission.js";
import { CallDelivery } from "./delivery.js";
import type { BatchToolCallObserver, ToolCallRequest } from "./types.js";
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const request = (callId: string): ToolCallRequest => ({
  callId,
  runId: "run",
  sessionId: "session",
  messageId: "message",
  toolName: "work",
  params: {},
});
function setup(
  execute: () => Promise<{ output: string }>,
  maxConcurrency = 10,
): ReturnType<typeof createToolScheduler> {
  const bus = createBus();
  const permissionState = createPermissionState({
    bus,
    initialLevel: "full-access",
  });
  const scheduler = createToolScheduler({
    bus,
    permissionState,
    config: { concurrency: { maxConcurrency } },
  });
  scheduler.register(
    withToolAdmission(
      {
        name: "work",
        description: "work",
        source: "builtin",
        category: "readonly",
        parametersJsonSchema: { type: "object" },
        execute,
      },
      { plan: () => [] },
    ),
  );
  return scheduler;
}
const noop = (): Promise<void> => Promise.resolve(undefined);
it("clears predecessor facts when waiting ends in cancellation", async () => {
  const delivery = new CallDelivery(
    request("cancelled"),
    0,
    { onCallState: noop, onCallSettled: noop },
    () => undefined,
    1,
  );
  await delivery.update({
    phase: "waiting-predecessor",
    waitReason: "predecessor",
    blockingCallIds: ["first"],
    predecessorsKnown: true,
  });
  await delivery.settle({ callId: "cancelled", status: "cancelled" }, 2);
  expect(delivery.state).toMatchObject({
    phase: "ended",
    outcome: "cancelled",
  });
  expect(delivery.state.blockingCallIds).toBeUndefined();
  expect(delivery.state.predecessorsKnown).toBeUndefined();
});
describe("reliable batch delivery", () => {
  it("awaits settlement delivery but releases execution capacity before saving", async () => {
    const save = deferred<undefined>();
    const second = deferred<undefined>();
    let executions = 0;
    const delivered: number[] = [];
    const scheduler = setup(() => {
      executions++;
      if (executions === 2) second.resolve(undefined);
      return Promise.resolve({ output: "ok" });
    }, 1);
    const batch = scheduler.executeBatch({
      calls: [request("a"), request("b")],
      observer: {
        onCallState: noop,
        onCallSettled: async (_request, index) => {
          delivered.push(index);
          if (index === 0) await save.promise;
        },
      },
    });
    await second.promise;
    expect(executions).toBe(2);
    let finished = false;
    void batch.then(() => {
      finished = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(finished).toBe(false);
    save.resolve(undefined);
    expect((await batch).map((r) => r.callId)).toEqual(["a", "b"]);
    expect(delivered.sort()).toEqual([0, 1]);
  });
  it("a preparing save failure is fatal and prevents execute", async () => {
    let executions = 0;
    const scheduler = setup(() => {
      executions++;
      return Promise.resolve({ output: "ok" });
    });
    await expect(
      scheduler.executeBatch({
        calls: [request("a")],
        observer: {
          onCallState: () => Promise.reject(new Error("disk failed")),
          onCallSettled: noop,
        },
      }),
    ).rejects.toMatchObject({ name: "ToolDeliveryError" });
    expect(executions).toBe(0);
  });
  it("records actual start after invocation and orders terminal delivery after start save", async () => {
    const save = deferred<undefined>();
    const started = deferred<undefined>();
    let invoked = false;
    const order: string[] = [];
    const scheduler = setup(() => {
      invoked = true;
      return Promise.resolve({ output: "ok" });
    });
    const observer: BatchToolCallObserver = {
      onCallState: async (_request, state) => {
        order.push(state.phase);
        if (state.phase === "executing") {
          expect(invoked).toBe(true);
          expect(state.executionStartedAt).toBeTypeOf("number");
          started.resolve(undefined);
          await save.promise;
        }
      },
      onCallSettled: () => {
        order.push("ended");
        return Promise.resolve();
      },
    };
    const batch = scheduler.executeBatch({ calls: [request("a")], observer });
    await started.promise;
    expect(order).not.toContain("ended");
    save.resolve(undefined);
    await batch;
    expect(order.at(-1)).toBe("ended");
  });
});

it("keeps late cleanup on the original terminal observation without a second result", async () => {
  const operation = deferred<{ output: string }>();
  const cleaned = deferred<undefined>();
  const states: import("./types.js").ToolExecutionObservation[] = [];
  let results = 0;
  const bus = createBus();
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    config: { timeout: { defaultTimeout: 5 } },
    cleanupObservationMs: 100,
  });
  scheduler.register(
    withToolAdmission(
      {
        name: "work",
        description: "work",
        source: "builtin",
        category: "readonly",
        parametersJsonSchema: { type: "object" },
        execute: () => operation.promise,
      },
      { plan: () => [] },
    ),
  );
  const batch = await scheduler.executeBatch({
    calls: [request("late")],
    observer: {
      onCallState: (_r, state) => {
        states.push(state);
        if (state.cleanup === "confirmed") cleaned.resolve(undefined);
        return Promise.resolve();
      },
      onCallSettled: (_r, _i, result) => {
        results++;
        expect(result.execution).toMatchObject({
          phase: "ended",
          outcome: "timed-out",
          cleanup: "in-progress",
        });
        return Promise.resolve();
      },
    },
  });
  expect(batch[0].error?.type).toBe("TimeoutError");
  operation.resolve({ output: "too late" });
  await cleaned.promise;
  expect(states.at(-1)).toMatchObject({
    phase: "ended",
    outcome: "timed-out",
    cleanup: "confirmed",
  });
  expect(results).toBe(1);
});

it("cancels an executing sibling on save failure while a separate batch remains healthy", async () => {
  const bus = createBus();
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
  });
  const siblingStarted = deferred<undefined>();
  const siblingAborted = deferred<undefined>();
  const healthy = deferred<{ output: string }>();
  scheduler.register(
    withToolAdmission(
      {
        name: "work",
        description: "work",
        source: "builtin",
        category: "readonly",
        parametersJsonSchema: { type: "object" },
        execute: async (params, context) => {
          if (params.healthy) return healthy.promise;
          if (params.sibling) {
            context.signal.addEventListener(
              "abort",
              () => {
                siblingAborted.resolve(undefined);
              },
              { once: true },
            );
            siblingStarted.resolve(undefined);
            return new Promise((resolve) => {
              context.signal.addEventListener(
                "abort",
                () => {
                  resolve({ output: "aborted" });
                },
                { once: true },
              );
            });
          }
          await siblingStarted.promise;
          return { output: "failure" };
        },
      },
      { plan: () => [] },
    ),
  );
  const other = scheduler.executeBatch({
    calls: [
      {
        ...request("healthy"),
        sessionId: "other",
        runId: "other",
        params: { healthy: true },
      },
    ],
    observer: { onCallState: noop, onCallSettled: noop },
  });
  const failed = scheduler.executeBatch({
    calls: [
      request("fail"),
      { ...request("sibling"), params: { sibling: true } },
    ],
    observer: {
      onCallState: noop,
      onCallSettled: (r) =>
        r.callId === "fail"
          ? Promise.reject(new Error("disk"))
          : Promise.resolve(),
    },
  });
  await expect(failed).rejects.toMatchObject({ name: "ToolDeliveryError" });
  await siblingAborted.promise;
  healthy.resolve({ output: "healthy" });
  expect((await other)[0]).toMatchObject({
    status: "success",
    output: "healthy",
  });
});

it("synchronously aborts execution while the started state save is still pending", async () => {
  const save = deferred<undefined>();
  const saving = deferred<undefined>();
  let signal: AbortSignal | undefined;
  const bus = createBus();
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
  });
  scheduler.register(
    withToolAdmission(
      {
        name: "work",
        description: "work",
        source: "builtin",
        category: "readonly",
        parametersJsonSchema: { type: "object" },
        execute: (_p, c) => {
          signal = c.signal;
          return new Promise((resolve) => {
            c.signal.addEventListener(
              "abort",
              () => {
                resolve({ output: "aborted" });
              },
              { once: true },
            );
          });
        },
      },
      { plan: () => [] },
    ),
  );
  const batch = scheduler.executeBatch({
    calls: [request("cancel")],
    observer: {
      onCallState: async (_r, s) => {
        if (s.phase === "executing") {
          saving.resolve(undefined);
          await save.promise;
        }
      },
      onCallSettled: noop,
    },
  });
  await saving.promise;
  scheduler.cancel("cancel");
  expect(signal?.aborted).toBe(true);
  save.resolve(undefined);
  expect((await batch)[0].status).toBe("cancelled");
});

it("does not cancel another run that reused the same callId", async () => {
  const bus = createBus();
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
  });
  const ready = deferred<undefined>();
  const healthy = deferred<{ output: string }>();
  let healthySignal: AbortSignal | undefined;
  scheduler.register(
    withToolAdmission(
      {
        name: "work",
        description: "work",
        source: "builtin",
        category: "readonly",
        parametersJsonSchema: { type: "object" },
        execute: async (params, c) => {
          if (params.healthy) {
            healthySignal = c.signal;
            ready.resolve(undefined);
            return healthy.promise;
          }
          await ready.promise;
          return { output: "bad" };
        },
      },
      { plan: () => [] },
    ),
  );
  const failed = scheduler.executeBatch({
    calls: [request("same")],
    observer: {
      onCallState: noop,
      onCallSettled: () => Promise.reject(new Error("disk")),
    },
  });
  const other = scheduler.executeBatch({
    calls: [
      {
        ...request("same"),
        sessionId: "other",
        runId: "other",
        params: { healthy: true },
      },
    ],
    observer: { onCallState: noop, onCallSettled: noop },
  });
  await expect(failed).rejects.toMatchObject({ name: "ToolDeliveryError" });
  expect(healthySignal?.aborted).toBe(false);
  healthy.resolve({ output: "healthy" });
  expect((await other)[0].status).toBe("success");
});

it("delivers a resource-blocked error saying the new call did not execute", async () => {
  const bus = createBus();
  const stalled = deferred<{ output: string }>();
  let count = 0;
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    config: { timeout: { defaultTimeout: 5 } },
    cleanupObservationMs: 5,
  });
  const resources = [
    {
      kind: "file" as const,
      path: "/tmp/delivery-resource-blocked",
      scope: "file" as const,
      mode: "write" as const,
    },
  ];
  scheduler.register(
    withToolAdmission(
      {
        name: "work",
        description: "work",
        source: "builtin",
        category: "readonly",
        parametersJsonSchema: { type: "object" },
        execute: () => {
          count++;
          return stalled.promise;
        },
      },
      { plan: () => resources, resolve: () => ({ resources }) },
    ),
  );
  const observer = { onCallState: noop, onCallSettled: noop };
  await scheduler.executeBatch({ calls: [request("old")], observer });
  const result = await scheduler.executeBatch({
    calls: [request("blocked")],
    observer,
  });
  try {
    expect(count).toBe(1);
    expect(result[0].error?.message).toContain("not executed");
    expect(result[0].error?.message).toContain("do not automatically retry");
    expect(result[0].execution?.executionStartedAt).toBeUndefined();
  } finally {
    stalled.resolve({ output: "late" });
  }
});

it("saves each unchanged phase only once", async () => {
  const states: string[] = [];
  const scheduler = setup(() => Promise.resolve({ output: "ok" }));
  await scheduler.executeBatch({
    calls: [request("dedupe")],
    observer: {
      onCallState: (_r, state) => {
        states.push(state.phase);
        return Promise.resolve();
      },
      onCallSettled: noop,
    },
  });
  expect(states.filter((phase) => phase === "preparing")).toHaveLength(1);
});

it("rechecks a revoked permission after a queued-state save before invoke", async () => {
  const bus = createBus();
  const permissionState = createPermissionState({
    bus,
    initialLevel: "full-access",
  });
  const scheduler = createToolScheduler({ bus, permissionState });
  let invoked = 0;
  const saving = deferred<undefined>();
  const release = deferred<undefined>();
  scheduler.register(
    withToolAdmission(
      {
        name: "work",
        description: "work",
        source: "builtin",
        category: "readonly",
        parametersJsonSchema: { type: "object" },
        execute: () => {
          invoked++;
          return { output: "ok" };
        },
      },
      { plan: () => [] },
    ),
  );
  const batch = scheduler.executeBatch({
    calls: [request("revoked")],
    observer: {
      onCallState: async (_r, state) => {
        if (state.phase === "queued") {
          saving.resolve(undefined);
          await release.promise;
        }
      },
      onCallSettled: noop,
    },
  });
  await saving.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  permissionState.addSessionRule("session", {
    tool: "work",
    scope: "session",
    decision: "deny",
  });
  release.resolve(undefined);
  expect((await batch)[0].status).toBe("rejected");
  expect(invoked).toBe(0);
});

it("does not treat MCP metadata about another job as this invocation outcome", async () => {
  const scheduler = setup(() => Promise.resolve({ output: "query" }));
  scheduler.register({
    name: "remote_query",
    description: "query",
    source: "mcp",
    isTrusted: true,
    category: "readonly",
    parametersJsonSchema: { type: "object" },
    execute: () =>
      Promise.resolve({
        output: "old job timed out",
        metadata: { status: "timed_out" },
      }),
  });
  const [result] = await scheduler.executeBatch({
    calls: [{ ...request("remote"), toolName: "remote_query" }],
    observer: { onCallState: noop, onCallSettled: noop },
  });
  expect(result.execution?.outcome).toBe("success");
});
