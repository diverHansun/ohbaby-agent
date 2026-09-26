import { ToolSchedulerEvent } from "./events.js";
import { createHostLocalEnvironment } from "../../adapters/ui-runtime/host-local-environment.js";
import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import { createPermissionState } from "../../permission/index.js";
import { createToolScheduler } from "./scheduler.js";
import { beginSourceCleanup, getSourceCleanupState } from "./source-cleanup.js";
import { withToolAdmission, type ToolAdmission } from "./tool-admission.js";
import type {
  ToolExecutionFact,
  ToolExecutionOwner,
  ToolExecutionResult,
  ToolCallResult,
  ToolScheduler,
} from "./types.js";

const owner = (
  callId: string,
  workspaceKey = "source-workspace",
): ToolExecutionOwner => ({
  workspaceKey,
  scopeKey: "parent-scope",
  rootSessionId: "root",
  sessionId: "root",
  runId: "old-run",
  messageId: "m",
  callId,
});
function fixture(): {
  scheduler: ToolScheduler;
  facts: ToolExecutionFact[];
  executed: string[];
  execute(
    toolName: string,
    callId?: string,
    sessionId?: string,
  ): Promise<ToolCallResult>;
} {
  const facts: ToolExecutionFact[] = [];
  const executed: string[] = [];
  const bus = createBus();
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    config: { concurrency: { maxConcurrency: 1 } },
    resolveOwner: (request) => ({
      ...owner(request.callId),
      scopeKey: "child-scope",
      sessionId: request.sessionId,
      rootSessionId:
        request.sessionId === "independent" ? "other-root" : "root",
      runId: "new-run",
    }),
    onExecutionFact: (fact) => {
      facts.push(fact);
    },
  });
  const add = (name: string, admission?: ToolAdmission): void => {
    const tool = {
      name,
      source: "builtin" as const,
      category: "network" as const,
      description: "fixture",
      parametersJsonSchema: {},
      execute: (): ToolExecutionResult => {
        executed.push(name);
        return { output: "done" };
      },
    };
    scheduler.register(admission ? withToolAdmission(tool, admission) : tool);
  };
  add("unknown");
  add("independent", { plan: () => [] });
  add("file", {
    plan: () => [],
    resolve: () => ({
      resources: [
        {
          kind: "file",
          path: "/tmp/c3-source-file",
          scope: "file",
          mode: "read",
        },
      ],
    }),
  });
  add("control", { capacity: "control" });
  add("dispatch", { capacity: "dispatch" });
  const execute = (
    toolName: string,
    callId = toolName,
    sessionId = "child",
  ): Promise<ToolCallResult> =>
    scheduler.execute({
      toolName,
      callId,
      sessionId,
      messageId: "m",
      params: {},
    });
  return { scheduler, facts, executed, execute };
}

describe("C3 source cleanup admission", () => {
  it("retains independent records across runs/scopes, releasing only the confirmed owner", () => {
    const first = beginSourceCleanup(owner("first"));
    const second = beginSourceCleanup(owner("second"));
    try {
      first.markUnconfirmed();
      first.confirm();
      first.confirm();
      first.markUnconfirmed();
      expect(
        getSourceCleanupState({
          ...owner("new"),
          scopeKey: "other",
          runId: "new",
        }),
      ).toBe("in-progress");
      second.markUnconfirmed();
      expect(getSourceCleanupState(owner("new"))).toBe("unconfirmed");
      expect(
        getSourceCleanupState(owner("new", "other-workspace")),
      ).toBeUndefined();
    } finally {
      first.confirm();
      second.confirm();
    }
  });
  it("waits without capacity, lets independent roots/control work proceed, then fails existing and new callers without starting", async () => {
    const cleanup = beginSourceCleanup(owner("old"));
    const f = fixture();
    const pending = f.execute("unknown", "waiting");
    try {
      await vi.waitFor(() => {
        expect(f.facts.some((fact) => fact.reason === "source-cleanup")).toBe(
          true,
        );
      });
      for (const tool of ["independent", "control", "dispatch"])
        expect((await f.execute(tool)).status).toBe("success");
      expect(
        (await f.execute("unknown", "other-root", "independent")).status,
      ).toBe("success");
      cleanup.markUnconfirmed();
      expect(await pending).toMatchObject({
        status: "error",
        error: { type: "ExecutionError" },
      });
      expect((await f.execute("file")).status).toBe("error");
      expect((await f.execute("unknown", "later")).status).toBe("error");
      expect(
        f.facts.filter(
          (fact) =>
            ["waiting", "file", "later"].includes(fact.owner.callId) &&
            fact.phase === "started",
        ),
      ).toHaveLength(0);
      const replacement = fixture();
      expect((await replacement.execute("unknown", "recreated")).status).toBe(
        "error",
      );
      cleanup.confirm();
      expect((await replacement.execute("unknown", "recovered")).status).toBe(
        "success",
      );
      expect(f.executed.filter((name) => name === "unknown")).toHaveLength(1);
    } finally {
      cleanup.confirm();
      f.scheduler.cancelAll();
      await pending;
    }
  });
  it("gives cancellation priority and wakes a normal waiter on confirmation", async () => {
    const cleanup = beginSourceCleanup(owner("old"));
    const f = fixture();
    const cancelled = f.execute("unknown", "cancelled");
    const waiting = f.execute("file", "waiting");
    try {
      await vi.waitFor(() => {
        expect(
          f.facts.filter((fact) => fact.reason === "source-cleanup"),
        ).toHaveLength(2);
      });
      f.scheduler.cancel("cancelled");
      cleanup.confirm();
      expect((await cancelled).status).toBe("cancelled");
      expect((await waiting).status).toBe("success");
      expect(f.executed).toEqual(["file"]);
    } finally {
      cleanup.confirm();
      f.scheduler.cancelAll();
      await Promise.all([cancelled, waiting]);
    }
  });
});

it("keeps tool-owned cleanup facts separate from logical Promise completion", async () => {
  const bus = createBus();
  const facts: ToolExecutionFact[] = [];
  let report!: NonNullable<
    import("./types.js").ToolExecutionContext["reportCleanup"]
  >;
  const scheduler = createToolScheduler({
    bus,
    cleanupObservationMs: 1,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    onExecutionFact: (fact) => {
      facts.push(fact);
    },
  });
  scheduler.register(
    withToolAdmission(
      {
        name: "owned",
        source: "builtin",
        description: "fixture",
        parametersJsonSchema: {},
        execute(_params, context) {
          if (!context.reportCleanup)
            throw new Error("Missing cleanup reporter");
          report = context.reportCleanup;
          report("in-progress");
          scheduler.cancel(context.callId);
          return { output: "logical result" };
        },
      },
      { cleanupOwner: "tool" },
    ),
  );
  const result = await scheduler.execute({
    callId: "owned",
    toolName: "owned",
    sessionId: "s",
    messageId: "m",
    params: {},
  });
  expect(result.status).toBe("cancelled");
  await vi.waitFor(() => {
    expect(facts.some((fact) => fact.phase === "settled")).toBe(true);
  });
  expect(facts.map((fact) => fact.phase)).toEqual([
    "started",
    "cleanup",
    "settled",
  ]);
  expect(facts.filter((fact) => fact.cleanup === "confirmed")).toHaveLength(0);
  report("unconfirmed");
  report("confirmed");
  await vi.waitFor(() => {
    expect(facts.filter((fact) => fact.cleanup === "confirmed")).toHaveLength(
      1,
    );
  });
  expect(facts.filter((fact) => fact.phase === "settled")).toHaveLength(1);
  expect(facts.every((fact) => fact.owner.callId === "owned")).toBe(true);
});

it("does not reserve a file behind source cleanup against another root", async () => {
  const cleanup = beginSourceCleanup(owner("old"));
  const f = fixture();
  const pending = f.execute("file", "blocked-file");
  try {
    await vi.waitFor(() => {
      expect(f.facts.some((fact) => fact.reason === "source-cleanup")).toBe(
        true,
      );
    });
    expect(
      (await f.execute("file", "independent-file", "independent")).status,
    ).toBe("success");
    cleanup.markUnconfirmed();
    expect((await pending).status).toBe("error");
  } finally {
    cleanup.confirm();
    f.scheduler.cancelAll();
    await pending;
  }
});

it("reports cleanup delivery errors without changing process cleanup facts or the logical result", async () => {
  const bus = createBus();
  const facts: ToolExecutionFact[] = [];
  const errors: { error: unknown; fact: ToolExecutionFact }[] = [];
  const failure = new Error("environment disposal failed");
  const scheduler = createToolScheduler({
    bus,
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    onExecutionFact: (fact) => {
      facts.push(fact);
    },
    onExecutionFactError: (error, fact) => {
      errors.push({ error, fact });
      throw new Error("observer also failed");
    },
  });
  scheduler.register(
    withToolAdmission(
      {
        name: "owned-error",
        source: "builtin",
        description: "fixture",
        parametersJsonSchema: {},
        execute(_params, context) {
          if (!context.reportCleanupError)
            throw new Error("Missing cleanup error reporter");
          context.reportCleanup?.("in-progress");
          context.reportCleanupError(failure);
          context.reportCleanup?.("confirmed");
          return { output: "done" };
        },
      },
      { cleanupOwner: "tool" },
    ),
  );
  expect(
    await scheduler.execute({
      callId: "owned-error",
      toolName: "owned-error",
      sessionId: "s",
      runId: "original-run",
      messageId: "m",
      params: {},
    }),
  ).toMatchObject({ status: "success", output: "done" });
  await vi.waitFor(() => {
    expect(facts.some((fact) => fact.phase === "settled")).toBe(true);
  });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    error: failure,
    fact: {
      phase: "cleanup",
      owner: { callId: "owned-error", runId: "original-run" },
    },
  });
  expect(errors[0].fact.cleanup).toBeUndefined();
  expect(
    facts
      .filter((fact) => fact.phase === "cleanup")
      .map((fact) => fact.cleanup),
  ).toEqual(["in-progress", "confirmed"]);
});

it.each([
  ["status", "in-progress"],
  ["status", "unconfirmed"],
  ["retain", "in-progress"],
  ["retain", "unconfirmed"],
] as const)(
  "rechecks source protection created by %s callback before invocation (%s)",
  async (boundary, state) => {
    const bus = createBus();
    const facts: ToolExecutionFact[] = [];
    let cleanup: ReturnType<typeof beginSourceCleanup> | undefined;
    let executions = 0;
    let releases = 0;
    const establishCleanup = (): void => {
      if (cleanup) return;
      cleanup = beginSourceCleanup(owner("callback-race"));
      if (state === "unconfirmed") cleanup.markUnconfirmed();
    };
    const scheduler = createToolScheduler({
      bus,
      permissionState: createPermissionState({
        bus,
        initialLevel: "full-access",
      }),
      resolveOwner: () => owner("sensitive"),
      onExecutionFact: (fact) => {
        facts.push(fact);
      },
    });
    bus.subscribe(ToolSchedulerEvent.StatusChanged, (event) => {
      if (boundary === "status" && event.currentStatus === "executing")
        establishCleanup();
    });
    scheduler.register({
      name: "sensitive",
      source: "builtin",
      description: "fixture",
      parametersJsonSchema: {},
      execute() {
        executions++;
        return { output: "done" };
      },
    });
    const result = scheduler.execute({
      callId: "sensitive",
      toolName: "sensitive",
      sessionId: "root",
      messageId: "m",
      params: {},
      environment: {
        ...createHostLocalEnvironment(),
        retain(): () => void {
          if (boundary === "retain") establishCleanup();
          return (): void => {
            releases++;
          };
        },
      },
    });
    try {
      if (state === "in-progress") {
        await vi.waitFor(() => {
          expect(facts.some((fact) => fact.reason === "source-cleanup")).toBe(
            true,
          );
        });
        expect(executions).toBe(0);
        expect(releases).toBe(1);
        expect(facts.some((fact) => fact.phase === "started")).toBe(false);
        cleanup?.confirm();
        expect((await result).status).toBe("success");
        expect(executions).toBe(1);
      } else {
        expect(await result).toMatchObject({
          status: "error",
          error: { type: "ExecutionError" },
        });
        expect(executions).toBe(0);
        expect(releases).toBe(1);
        expect(facts.some((fact) => fact.phase === "started")).toBe(false);
      }
    } finally {
      cleanup?.confirm();
      scheduler.cancelAll();
      await result;
    }
  },
);
