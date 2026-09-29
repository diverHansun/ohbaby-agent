import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createHostLocalEnvironment } from "../../adapters/ui-runtime/host-local-environment.js";
import { createBus } from "../../bus/index.js";
import { createPermissionState } from "../../permission/index.js";
import { createToolScheduler } from "./scheduler.js";
import { withToolAdmission } from "./tool-admission.js";
import type {
  ToolCallRequest,
  ToolExecutionFact,
  ToolExecutionResult,
} from "./types.js";
interface Gate<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}
function gate(): Gate<void>;
function gate<T>(): Gate<T>;
function gate<T>(): Gate<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const request = (callId: string, resource = "a"): ToolCallRequest => ({
  callId,
  toolName: "controlled",
  sessionId: "s",
  messageId: "m",
  params: { resource },
});
describe("C2 logical completion and true resource cleanup", () => {
  it.each([false, true])(
    "returns capacity on timeout but keeps protection through late rejection=%s",
    async (reject) => {
      const bus = createBus();
      const facts: ToolExecutionFact[] = [];
      const started = gate();
      const waited = gate();
      const operation = gate<ToolExecutionResult>();
      const executions: string[] = [];
      const scheduler = createToolScheduler({
        bus,
        permissionState: createPermissionState({
          bus,
          initialLevel: "full-access",
        }),
        config: {
          concurrency: { maxConcurrency: 1 },
          timeout: { defaultTimeout: 30 },
        },
        cleanupObservationMs: 60,
        onExecutionFact(fact) {
          facts.push(fact);
          if (fact.owner.callId === "waiter" && fact.reason === "resource")
            waited.resolve();
        },
      });
      scheduler.register(
        withToolAdmission(
          {
            name: "controlled",
            description: "fixture",
            source: "builtin",
            category: "write",
            parametersJsonSchema: {},
            execute(_params, context) {
              executions.push(context.callId);
              if (context.callId === "holder") {
                started.resolve();
                return operation.promise;
              }
              return { output: "done" };
            },
          },
          {
            plan: (params) => [
              { kind: "scope", key: String(params.resource), mode: "write" },
            ],
            resolve: (params) => ({
              resources: [
                { kind: "scope", key: String(params.resource), mode: "write" },
              ],
            }),
          },
        ),
      );
      const holder = scheduler.execute(request("holder"));
      let waiter: Promise<unknown> | undefined;
      try {
        await started.promise;
        waiter = scheduler.execute(request("waiter"));
        await waited.promise;
        expect((await holder).error?.type).toBe("TimeoutError");
        expect(
          (await scheduler.execute(request("independent", "b"))).status,
        ).toBe("success");
        expect(executions).toEqual(["holder", "independent"]);
        const blocked = (await waiter) as {
          status: string;
          error?: { message: string };
          duration?: number;
        };
        expect(blocked.status).toBe("error");
        expect(blocked.error?.message).toContain("unconfirmed");
        expect(blocked.duration).toBeUndefined();
        expect((await scheduler.execute(request("later"))).status).toBe(
          "error",
        );
        expect(executions).not.toContain("later");
        if (reject) operation.reject(new Error("late failure"));
        else operation.resolve({ output: "late success" });
        await vi.waitFor(() => {
          expect(
            facts.some(
              (f) => f.owner.callId === "holder" && f.cleanup === "confirmed",
            ),
          ).toBe(true);
        });
        expect((await scheduler.execute(request("recovered"))).status).toBe(
          "success",
        );
        expect(executions).toEqual(["holder", "independent", "recovered"]);
        expect(
          facts.filter(
            (f) => f.owner.callId === "holder" && f.phase === "settled",
          ),
        ).toHaveLength(1);
        expect(
          facts.find(
            (f) => f.owner.callId === "holder" && f.phase === "settled",
          )?.outcome?.error?.type,
        ).toBe("TimeoutError");
      } finally {
        operation.resolve({});
        scheduler.cancelAll();
        await Promise.all([holder, waiter]);
      }
    },
  );

  it("orders synchronous cancellation cleanup after start and returns one cancelled result", async () => {
    const bus = createBus();
    const facts: ToolExecutionFact[] = [];
    const operation = gate<ToolExecutionResult>();
    const scheduler = createToolScheduler({
      bus,
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
      onExecutionFact(f) {
        facts.push(f);
      },
    });
    scheduler.register(
      withToolAdmission(
        {
          name: "controlled",
          description: "fixture",
          source: "builtin",
          parametersJsonSchema: {},
          execute(_p, ctx) {
            scheduler.cancel(ctx.callId);
            return operation.promise;
          },
        },
        { plan: () => [], resolve: () => ({ resources: [] }) },
      ),
    );
    try {
      expect((await scheduler.execute(request("sync-cancel"))).status).toBe(
        "cancelled",
      );
      operation.resolve({});
      await vi.waitFor(() => {
        expect(facts.some((f) => f.cleanup === "confirmed")).toBe(true);
      });
      expect(facts[0].phase).toBe("started");
      expect(facts.filter((f) => f.phase === "settled")).toHaveLength(1);
    } finally {
      operation.resolve({});
      scheduler.cancelAll();
    }
  });

  it("does not let delayed fact persistence hold capacity or prevent synchronous cancellation", async () => {
    const bus = createBus();
    const saved = gate();
    const started = gate();
    const operation = gate<ToolExecutionResult>();
    const facts: ToolExecutionFact[] = [];
    const scheduler = createToolScheduler({
      bus,
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
      config: { concurrency: { maxConcurrency: 1 } },
      async onExecutionFact(f) {
        if (f.owner.callId === "holder" && f.phase === "started")
          await saved.promise;
        facts.push(f);
      },
    });
    scheduler.register(
      withToolAdmission(
        {
          name: "controlled",
          description: "fixture",
          source: "builtin",
          parametersJsonSchema: {},
          execute(_p, ctx) {
            if (ctx.callId === "holder") {
              started.resolve();
              return operation.promise;
            }
            return { output: "next" };
          },
        },
        { plan: () => [] },
      ),
    );
    const first = scheduler.execute(request("holder"));
    try {
      await started.promise;
      expect(scheduler.cancel("holder")).toBe(true);
      expect((await first).status).toBe("cancelled");
      expect((await scheduler.execute(request("other"))).status).toBe(
        "success",
      );
      expect(facts.every((f) => f.owner.callId !== "holder")).toBe(true);
      saved.resolve();
      operation.resolve({});
      await vi.waitFor(() => {
        expect(
          facts.filter((f) => f.owner.callId === "holder").map((f) => f.phase),
        ).toEqual(["started", "cleanup", "settled", "cleanup"]);
      });
    } finally {
      saved.resolve();
      operation.resolve({});
      scheduler.cancelAll();
      await first;
    }
  });
});

it("reports actual invocation time even if synchronous tool work delays publication", async () => {
  let now = 100;
  const bus = createBus();
  const facts: ToolExecutionFact[] = [];
  const scheduler = createToolScheduler({
    bus,
    now: () => now,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    onExecutionFact(f) {
      facts.push(f);
    },
  });
  scheduler.register({
    name: "controlled",
    description: "fixture",
    source: "builtin",
    parametersJsonSchema: {},
    execute() {
      now = 700;
      return { output: "done" };
    },
  });
  const result = await scheduler.execute(request("sync-work"));
  await vi.waitFor(() => {
    expect(facts.some((f) => f.phase === "settled")).toBe(true);
  });
  expect(facts.find((f) => f.phase === "started")?.timestamp).toBe(100);
  expect(result.duration).toBe(600);
});

it("reports synchronous environment release failure without replacing a successful tool outcome", async () => {
  const bus = createBus();
  const failure = new Error("environment release failed");
  const errors: { error: unknown; fact: ToolExecutionFact }[] = [];
  const facts: ToolExecutionFact[] = [];
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    config: { concurrency: { maxConcurrency: 1 } },
    onExecutionFact(fact): void {
      facts.push(fact);
    },
    onExecutionFactError(error, fact): void {
      errors.push({ error, fact });
    },
  });
  scheduler.register(
    withToolAdmission(
      {
        name: "controlled",
        description: "fixture",
        source: "builtin",
        parametersJsonSchema: {},
        execute: (): ToolExecutionResult => ({ output: "tool completed" }),
      },
      {
        plan: () => [{ kind: "scope", key: "release-failure", mode: "write" }],
        resolve: () => ({
          resources: [{ kind: "scope", key: "release-failure", mode: "write" }],
        }),
      },
    ),
  );
  let releases = 0;
  const environment = {
    ...createHostLocalEnvironment(os.tmpdir()),
    retain(): () => void {
      return (): void => {
        releases += 1;
        throw failure;
      };
    },
  };
  try {
    const result = await scheduler.execute({
      ...request("release-failure"),
      environment,
    });
    expect(result).toMatchObject({
      status: "success",
      output: "tool completed",
    });
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
      expect(facts.some((fact) => fact.phase === "settled")).toBe(true);
    });
    expect(errors[0]).toMatchObject({
      error: failure,
      fact: {
        owner: { callId: "release-failure" },
        phase: "cleanup",
        cleanup: "unconfirmed",
      },
    });
    expect(releases).toBe(1);
    expect(
      facts.find((fact) => fact.phase === "settled")?.outcome,
    ).toMatchObject({ status: "success", output: "tool completed" });
    // Neither the resource nor the single ordinary slot leaks on cleanup failure.
    expect(
      await scheduler.execute(request("after-release-failure")),
    ).toMatchObject({ status: "success", output: "tool completed" });
  } finally {
    scheduler.cancelAll();
  }
});
