import { describe, expect, it, vi } from "vitest";
import { createBus, type BusInstance } from "../../bus/index.js";
import { createToolScheduler, ToolSchedulerEvent } from "./index.js";
import type {
  PermissionPort,
  PolicyDecision,
  PolicyPort,
  Tool,
  ToolCallStatus,
  ToolExecutionContext,
  ToolExecutionEnvironment,
  ToolExecutionResult,
  ToolScheduler,
  ToolSchedulerOptions,
} from "./types.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function createPolicy(decision: PolicyPort["check"]): PolicyPort {
  return {
    check: decision,
    getMode: () => "agent",
  };
}

interface SchedulerFixture {
  readonly bus: BusInstance;
  readonly completed: string[];
  readonly scheduler: ToolScheduler;
  readonly started: string[];
  readonly statuses: ToolCallStatus[];
}

function createTool(input: {
  readonly name: string;
  readonly category?: Tool["category"];
  readonly execute?: Tool["execute"];
  readonly parametersJsonSchema?: Tool["parametersJsonSchema"];
}): Tool {
  return {
    category: input.category,
    description: `${input.name} description`,
    execute:
      input.execute ??
      ((): Promise<ToolExecutionResult> =>
        Promise.resolve({ output: `${input.name} output` })),
    name: input.name,
    parametersJsonSchema: input.parametersJsonSchema ?? {},
    source: "builtin",
  };
}

function createScheduler(
  options: {
    readonly policy?: PolicyPort;
    readonly permission?: PermissionPort;
    readonly config?: ToolSchedulerOptions["config"];
    readonly now?: () => number;
  } = {},
): SchedulerFixture {
  const bus = createBus();
  const statuses: ToolCallStatus[] = [];
  const started: string[] = [];
  const completed: string[] = [];
  const scheduler = createToolScheduler({
    bus,
    config: options.config,
    now: options.now ?? Date.now,
    permission:
      options.permission ??
      ({
        ask: (): Promise<"once"> => Promise.resolve("once"),
      } satisfies PermissionPort),
    policy:
      options.policy ??
      createPolicy(
        (): Promise<PolicyDecision> => Promise.resolve({ type: "allow" }),
      ),
  });

  bus.subscribe(ToolSchedulerEvent.StatusChanged, (payload) => {
    statuses.push(payload.currentStatus);
  });
  bus.subscribe(ToolSchedulerEvent.ExecutionStarted, (payload) => {
    started.push(payload.callId);
  });
  bus.subscribe(ToolSchedulerEvent.ExecutionCompleted, (payload) => {
    completed.push(payload.callId);
  });

  return { bus, completed, scheduler, started, statuses };
}

describe("ToolScheduler", () => {
  it("executes allowed tools and publishes state events", async () => {
    const { completed, scheduler, started, statuses } = createScheduler();
    scheduler.register(createTool({ name: "read" }));

    await expect(
      scheduler.execute({
        callId: "call_1",
        messageId: "message_1",
        params: { path: "README.md" },
        sessionId: "session_1",
        toolName: "read",
      }),
    ).resolves.toMatchObject({
      callId: "call_1",
      output: "read output",
      status: "success",
    });

    expect(statuses).toEqual([
      "checking_policy",
      "queued",
      "executing",
      "success",
    ]);
    expect(started).toEqual(["call_1"]);
    expect(completed).toEqual(["call_1"]);
    expect(scheduler.getStatus("call_1")).toBe("success");
  });

  it("passes the runtime environment to tool execution", async () => {
    const { scheduler } = createScheduler();
    const environment = {
      workdir: "D:/workspace/session_1",
      resolvePath(inputPath: string): string {
        return `${this.workdir}/${inputPath}`;
      },
      resolvePathForExisting(inputPath: string): Promise<string> {
        return Promise.resolve(`${this.workdir}/${inputPath}`);
      },
      resolvePathForWrite(inputPath: string): Promise<string> {
        return Promise.resolve(`${this.workdir}/${inputPath}`);
      },
      resolveCommandContext(): { readonly cwd: string; readonly kind: string } {
        return { cwd: this.workdir, kind: "host-local" };
      },
    };
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          const runtime = (
            context as {
              readonly environment?: {
                readonly workdir: string;
                resolveCommandContext(): { readonly cwd: string };
              };
            }
          ).environment;

          return {
            output: `${runtime?.workdir ?? "missing"}|${
              runtime?.resolveCommandContext().cwd ?? "missing"
            }`,
          };
        },
        name: "read",
      }),
    );

    await expect(
      scheduler.execute({
        callId: "call_1",
        environment,
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "read",
      }),
    ).resolves.toMatchObject({
      output: "D:/workspace/session_1|D:/workspace/session_1",
      status: "success",
    });
  });

  it("handles tool-not-found, policy deny, and permission rejection without executing", async () => {
    const deny = createScheduler({
      policy: createPolicy(() => Promise.resolve({ type: "deny" })),
    });
    const askReject = createScheduler({
      permission: { ask: () => Promise.resolve("reject") },
      policy: createPolicy(() => Promise.resolve({ type: "ask" })),
    });
    const execute = vi.fn().mockResolvedValue({ output: "nope" });
    deny.scheduler.register(createTool({ execute, name: "bash" }));
    askReject.scheduler.register(createTool({ execute, name: "edit" }));

    await expect(
      deny.scheduler.execute({
        callId: "missing",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "missing_tool",
      }),
    ).resolves.toMatchObject({
      error: { type: "ToolNotFoundError" },
      status: "error",
    });
    await expect(
      deny.scheduler.execute({
        callId: "denied",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "bash",
      }),
    ).resolves.toMatchObject({
      error: { type: "PolicyDeniedError" },
      status: "rejected",
    });
    await expect(
      askReject.scheduler.execute({
        callId: "rejected",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      error: { type: "PermissionRejectedError" },
      status: "rejected",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates request identity and tool parameters before execution", async () => {
    const execute = vi.fn().mockResolvedValue({ output: "validated" });
    const { scheduler } = createScheduler();
    scheduler.register(
      createTool({
        execute,
        name: "needs_path",
        parametersJsonSchema: {
          properties: { path: { type: "string" } },
          required: ["path"],
          type: "object",
        },
      }),
    );

    await expect(
      scheduler.execute({
        callId: "",
        messageId: "message_1",
        params: { path: "README.md" },
        sessionId: "session_1",
        toolName: "needs_path",
      }),
    ).resolves.toMatchObject({
      error: { type: "ValidationError" },
      status: "error",
    });
    await expect(
      scheduler.execute({
        callId: "invalid_params",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "needs_path",
      }),
    ).resolves.toMatchObject({
      error: { type: "ValidationError" },
      status: "error",
    });
    await expect(
      scheduler.execute({
        callId: "valid_params",
        messageId: "message_1",
        params: { path: "README.md" },
        sessionId: "session_1",
        toolName: "needs_path",
      }),
    ).resolves.toMatchObject({
      output: "validated",
      status: "success",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("maps thrown permission rejections into rejected results", async () => {
    class RejectedError extends Error {}

    const execute = vi.fn().mockResolvedValue({ output: "nope" });
    const { scheduler } = createScheduler({
      permission: {
        ask: () => {
          throw new RejectedError("rejected");
        },
      },
      policy: createPolicy(() => Promise.resolve({ type: "ask" })),
    });
    scheduler.register(createTool({ execute, name: "edit" }));

    await expect(
      scheduler.execute({
        callId: "permission_error",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      error: { type: "PermissionRejectedError" },
      status: "rejected",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("queues write calls behind read calls and releases them afterward", async () => {
    const readBlocker = deferred<{ readonly output: string }>();
    const started: string[] = [];
    const { scheduler } = createScheduler();
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return readBlocker.promise;
        },
        name: "read",
      }),
    );
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return Promise.resolve({ output: "written" });
        },
        name: "edit",
      }),
    );

    const readPromise = scheduler.execute({
      callId: "read_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "read",
    });
    const writePromise = scheduler.execute({
      callId: "write_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });

    await vi.waitFor(() => {
      expect(started).toEqual(["read_1"]);
      expect(scheduler.getStatus("write_1")).toBe("queued");
    });
    readBlocker.resolve({ output: "read done" });

    await expect(readPromise).resolves.toMatchObject({ status: "success" });
    await expect(writePromise).resolves.toMatchObject({ status: "success" });
    expect(started).toEqual(["read_1", "write_1"]);
  });

  it("lets memory tools bypass read/write locks and limits subagent concurrency", async () => {
    const blockers = [
      deferred<{ readonly output: string }>(),
      deferred<{ readonly output: string }>(),
    ];
    const started: string[] = [];
    const { scheduler } = createScheduler({
      config: { concurrency: { maxSubagentConcurrency: 1 } },
    });
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return blockers[0].promise;
        },
        name: "edit",
      }),
    );
    scheduler.register(
      createTool({
        category: "memory",
        execute: (_params, context) => {
          started.push(context.callId);
          return Promise.resolve({ output: "remembered" });
        },
        name: "memory_add",
      }),
    );
    scheduler.register(
      createTool({
        category: "subagent",
        execute: (_params, context) => {
          started.push(context.callId);
          return blockers[1].promise;
        },
        name: "task",
      }),
    );

    const write = scheduler.execute({
      callId: "write_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });
    const memory = scheduler.execute({
      callId: "memory_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "memory_add",
    });
    const subagent1 = scheduler.execute({
      callId: "task_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "task",
    });
    const subagent2 = scheduler.execute({
      callId: "task_2",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "task",
    });

    await vi.waitFor(() => {
      expect(started).toContain("write_1");
      expect(started).toContain("memory_1");
      expect(started).toContain("task_1");
      expect(scheduler.getStatus("task_2")).toBe("queued");
    });

    blockers[1].resolve({ output: "task done" });
    blockers[0].resolve({ output: "write done" });

    await expect(memory).resolves.toMatchObject({ status: "success" });
    await expect(subagent1).resolves.toMatchObject({ status: "success" });
    await expect(subagent2).resolves.toMatchObject({ status: "success" });
    await expect(write).resolves.toMatchObject({ status: "success" });
  });

  it("executes batches in waves while returning results in input order", async () => {
    const started: string[] = [];
    const { scheduler } = createScheduler({
      config: { concurrency: { maxSubagentConcurrency: 1 } },
    });
    for (const toolName of ["read", "edit", "memory_add"]) {
      scheduler.register(
        createTool({
          execute: (_params, context) => {
            started.push(context.callId);
            return Promise.resolve({ output: context.callId });
          },
          name: toolName,
        }),
      );
    }

    await expect(
      scheduler.executeBatch({
        calls: [
          {
            callId: "read_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "read",
          },
          {
            callId: "write_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "edit",
          },
          {
            callId: "memory_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "memory_add",
          },
        ],
      }),
    ).resolves.toMatchObject([
      { callId: "read_1", status: "success" },
      { callId: "write_1", status: "success" },
      { callId: "memory_1", status: "success" },
    ]);
    expect(started).toContain("memory_1");
    expect(started.indexOf("read_1")).toBeLessThan(started.indexOf("write_1"));
  });

  it("passes each batch call environment through waves and detached tools", async () => {
    const { scheduler } = createScheduler({
      config: { concurrency: { maxSubagentConcurrency: 1 } },
    });
    for (const tool of [
      { name: "read", category: "readonly" },
      { name: "edit", category: "write" },
      { name: "memory_add", category: "memory" },
      { name: "task", category: "subagent" },
    ] as const) {
      scheduler.register(
        createTool({
          category: tool.category,
          execute: (_params, context): Promise<ToolExecutionResult> =>
            Promise.resolve({
              output: `${context.callId}:${context.environment?.workdir ?? "missing"}`,
            }),
          name: tool.name,
        }),
      );
    }

    const makeEnvironment = (workdir: string): ToolExecutionEnvironment => ({
      workdir,
      resolvePath(inputPath: string): string {
        return `${workdir}/${inputPath}`;
      },
      resolvePathForExisting(inputPath: string): Promise<string> {
        return Promise.resolve(`${workdir}/${inputPath}`);
      },
      resolvePathForWrite(inputPath: string): Promise<string> {
        return Promise.resolve(`${workdir}/${inputPath}`);
      },
      resolveCommandContext(): { readonly cwd: string; readonly kind: string } {
        return { cwd: workdir, kind: "host-local" };
      },
    });

    await expect(
      scheduler.executeBatch({
        calls: [
          {
            callId: "read_1",
            environment: makeEnvironment("D:/workspace/read"),
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "read",
          },
          {
            callId: "write_1",
            environment: makeEnvironment("D:/workspace/write"),
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "edit",
          },
          {
            callId: "memory_1",
            environment: makeEnvironment("D:/workspace/memory"),
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "memory_add",
          },
          {
            callId: "task_1",
            environment: makeEnvironment("D:/workspace/task"),
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "task",
          },
        ],
      }),
    ).resolves.toMatchObject([
      { output: "read_1:D:/workspace/read", status: "success" },
      { output: "write_1:D:/workspace/write", status: "success" },
      { output: "memory_1:D:/workspace/memory", status: "success" },
      { output: "task_1:D:/workspace/task", status: "success" },
    ]);
  });

  it("preflights every batch call before starting tools and confirms asks serially", async () => {
    const executionOrder: string[] = [];
    const permissionOrder: string[] = [];
    const policyChecks = new Set<string>();
    const { scheduler } = createScheduler({
      permission: {
        ask: (input) => {
          permissionOrder.push(input.toolName);
          return Promise.resolve("once");
        },
      },
      policy: {
        check: (input) => {
          policyChecks.add(input.toolName);
          if (input.toolName === "edit" || input.toolName === "bash") {
            return Promise.resolve({ type: "ask" });
          }
          return Promise.resolve({ type: "allow" });
        },
        getMode: () => "agent",
      },
    });
    for (const toolName of ["read", "edit", "bash"]) {
      scheduler.register(
        createTool({
          execute: (_params, context) => {
            expect(policyChecks).toEqual(new Set(["read", "edit", "bash"]));
            executionOrder.push(context.callId);
            return Promise.resolve({ output: context.callId });
          },
          name: toolName,
        }),
      );
    }

    await expect(
      scheduler.executeBatch({
        calls: [
          {
            callId: "read_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "read",
          },
          {
            callId: "write_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "edit",
          },
          {
            callId: "danger_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "bash",
          },
        ],
      }),
    ).resolves.toMatchObject([
      { callId: "read_1", status: "success" },
      { callId: "write_1", status: "success" },
      { callId: "danger_1", status: "success" },
    ]);
    expect(permissionOrder).toEqual(["edit", "bash"]);
    expect(executionOrder).toEqual(["read_1", "write_1", "danger_1"]);
  });

  it("does not run batch policy or permission side effects for already cancelled calls", async () => {
    const policyChecks: string[] = [];
    const permissionOrder: string[] = [];
    const preAborted = new AbortController();
    preAborted.abort();
    const { scheduler } = createScheduler({
      permission: {
        ask: (input) => {
          permissionOrder.push(input.toolName);
          if (input.toolName === "edit") {
            scheduler.cancel("danger_1");
          }
          return Promise.resolve("once");
        },
      },
      policy: {
        check: (input) => {
          policyChecks.push(input.toolName);
          if (input.toolName === "edit" || input.toolName === "bash") {
            return Promise.resolve({ type: "ask" });
          }
          return Promise.resolve({ type: "allow" });
        },
        getMode: () => "agent",
      },
    });
    for (const toolName of ["read", "edit", "bash"]) {
      scheduler.register(createTool({ name: toolName }));
    }

    await expect(
      scheduler.executeBatch({
        calls: [
          {
            callId: "pre_aborted",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            signal: preAborted.signal,
            toolName: "read",
          },
          {
            callId: "write_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "edit",
          },
          {
            callId: "danger_1",
            messageId: "message_1",
            params: {},
            sessionId: "session_1",
            toolName: "bash",
          },
        ],
      }),
    ).resolves.toMatchObject([
      { callId: "pre_aborted", status: "cancelled" },
      { callId: "write_1", status: "success" },
      { callId: "danger_1", status: "cancelled" },
    ]);
    expect(policyChecks).toEqual(["edit", "bash"]);
    expect(permissionOrder).toEqual(["edit"]);
  });

  it("does not let later reads starve a queued write", async () => {
    const readBlocker = deferred<ToolExecutionResult>();
    const writeBlocker = deferred<ToolExecutionResult>();
    const started: string[] = [];
    const { scheduler } = createScheduler();
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          if (context.callId === "read_1") {
            return readBlocker.promise;
          }
          return Promise.resolve({ output: context.callId });
        },
        name: "read",
      }),
    );
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return writeBlocker.promise;
        },
        name: "edit",
      }),
    );

    const read1 = scheduler.execute({
      callId: "read_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "read",
    });
    const write1 = scheduler.execute({
      callId: "write_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });
    await vi.waitFor(() => {
      expect(scheduler.getStatus("write_1")).toBe("queued");
    });
    const read2 = scheduler.execute({
      callId: "read_2",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "read",
    });
    await vi.waitFor(() => {
      expect(scheduler.getStatus("read_2")).toBe("queued");
    });
    readBlocker.resolve({ output: "read_1" });
    await vi.waitFor(() => {
      expect(started).toEqual(["read_1", "write_1"]);
    });
    writeBlocker.resolve({ output: "write_1" });

    await expect(read1).resolves.toMatchObject({ status: "success" });
    await expect(write1).resolves.toMatchObject({ status: "success" });
    await expect(read2).resolves.toMatchObject({ status: "success" });
    expect(started).toEqual(["read_1", "write_1", "read_2"]);
  });

  it("starts later reads after a queued write barrier is cancelled", async () => {
    const readBlocker = deferred<ToolExecutionResult>();
    const started: string[] = [];
    const { scheduler } = createScheduler();
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          if (context.callId === "read_1") {
            return readBlocker.promise;
          }
          return Promise.resolve({ output: context.callId });
        },
        name: "read",
      }),
    );
    scheduler.register(createTool({ name: "edit" }));

    const read1 = scheduler.execute({
      callId: "read_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "read",
    });
    const write1 = scheduler.execute({
      callId: "write_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });
    await vi.waitFor(() => {
      expect(scheduler.getStatus("write_1")).toBe("queued");
    });
    const read2 = scheduler.execute({
      callId: "read_2",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "read",
    });
    await vi.waitFor(() => {
      expect(scheduler.getStatus("read_2")).toBe("queued");
    });

    expect(scheduler.cancel("write_1")).toBe(true);
    await expect(write1).resolves.toMatchObject({ status: "cancelled" });
    await expect(read2).resolves.toMatchObject({ status: "success" });
    expect(started).toEqual(["read_1", "read_2"]);
    readBlocker.resolve({ output: "read_1" });
    await expect(read1).resolves.toMatchObject({ status: "success" });
  });

  it("cancels queued calls and aborts executing calls", async () => {
    const running = deferred<{ readonly output: string }>();
    let executingSignal: AbortSignal | undefined;
    const { scheduler } = createScheduler();
    scheduler.register(
      createTool({
        execute: (_params, context: ToolExecutionContext) => {
          executingSignal = context.signal;
          return running.promise;
        },
        name: "edit",
      }),
    );

    const executing = scheduler.execute({
      callId: "write_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });
    const queued = scheduler.execute({
      callId: "write_2",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });

    await vi.waitFor(() => {
      expect(scheduler.getStatus("write_2")).toBe("queued");
    });

    expect(scheduler.cancel("write_2")).toBe(true);
    await expect(queued).resolves.toMatchObject({ status: "cancelled" });
    expect(scheduler.cancel("write_1")).toBe(true);
    expect(executingSignal?.aborted).toBe(true);
    running.resolve({ output: "ignored" });
    await expect(executing).resolves.toMatchObject({ status: "cancelled" });
  });

  it("times out non-cooperative tools and releases their slot", async () => {
    const started: string[] = [];
    const { scheduler } = createScheduler({
      config: { timeout: { defaultTimeout: 10 } },
    });
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return new Promise<ToolExecutionResult>(() => undefined);
        },
        name: "slow_write",
      }),
    );
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return Promise.resolve({ output: "after timeout" });
        },
        name: "edit",
      }),
    );

    await expect(
      scheduler.execute({
        callId: "slow_1",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "slow_write",
      }),
    ).resolves.toMatchObject({
      error: { type: "TimeoutError" },
      status: "error",
    });

    await expect(
      scheduler.execute({
        callId: "write_2",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      output: "after timeout",
      status: "success",
    });
    expect(started).toEqual(["slow_1", "write_2"]);
  });

  it("cancels non-cooperative executing tools and releases their slot", async () => {
    const started: string[] = [];
    const { scheduler } = createScheduler();
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return new Promise<ToolExecutionResult>(() => undefined);
        },
        name: "slow_write",
      }),
    );
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          return Promise.resolve({ output: "after cancel" });
        },
        name: "edit",
      }),
    );

    const running = scheduler.execute({
      callId: "slow_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "slow_write",
    });
    await vi.waitFor(() => {
      expect(started).toEqual(["slow_1"]);
    });

    expect(scheduler.cancel("slow_1")).toBe(true);
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      scheduler.execute({
        callId: "write_2",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      output: "after cancel",
      status: "success",
    });
    expect(started).toEqual(["slow_1", "write_2"]);
  });

  it("releases a granted slot when a queued call is cancelled before it resumes", async () => {
    const first = deferred<ToolExecutionResult>();
    const started: string[] = [];
    const { bus, scheduler } = createScheduler();
    scheduler.register(
      createTool({
        execute: (_params, context) => {
          started.push(context.callId);
          if (context.callId === "write_1") {
            return first.promise;
          }
          return Promise.resolve({ output: context.callId });
        },
        name: "edit",
      }),
    );
    bus.subscribe(ToolSchedulerEvent.ExecutionCompleted, (payload) => {
      if (payload.callId === "write_1") {
        scheduler.cancel("write_2");
      }
    });

    const write1 = scheduler.execute({
      callId: "write_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });
    const write2 = scheduler.execute({
      callId: "write_2",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });
    const write3 = scheduler.execute({
      callId: "write_3",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });

    await vi.waitFor(() => {
      expect(scheduler.getStatus("write_2")).toBe("queued");
    });
    first.resolve({ output: "first" });

    await expect(write1).resolves.toMatchObject({ status: "success" });
    await expect(write2).resolves.toMatchObject({ status: "cancelled" });
    await expect(write3).resolves.toMatchObject({
      output: "write_3",
      status: "success",
    });
    expect(started).toEqual(["write_1", "write_3"]);
  });

  it("does not execute a tool after execution-started subscribers cancel it", async () => {
    const execute = vi.fn().mockResolvedValue({ output: "should not run" });
    const { bus, scheduler } = createScheduler();
    scheduler.register(createTool({ execute, name: "edit" }));
    bus.subscribe(ToolSchedulerEvent.ExecutionStarted, (payload) => {
      if (payload.callId === "write_1") {
        scheduler.cancel("write_1");
      }
    });

    await expect(
      scheduler.execute({
        callId: "write_1",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("honors request abort signals before policy and while queued", async () => {
    const blocker = deferred<ToolExecutionResult>();
    const policyCheck = vi.fn().mockResolvedValue({ type: "allow" });
    const execute = vi.fn((_params, context: ToolExecutionContext) => {
      if (context.callId === "write_1") {
        return blocker.promise;
      }
      return Promise.resolve({ output: context.callId });
    });
    const { scheduler } = createScheduler({
      policy: createPolicy(policyCheck),
    });
    scheduler.register(createTool({ execute, name: "edit" }));

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      scheduler.execute({
        callId: "pre_aborted",
        messageId: "message_1",
        params: {},
        sessionId: "session_1",
        signal: preAborted.signal,
        toolName: "edit",
      }),
    ).resolves.toMatchObject({
      error: { type: "CancelledError" },
      status: "cancelled",
    });
    expect(policyCheck).not.toHaveBeenCalled();

    const queuedAbort = new AbortController();
    const write1 = scheduler.execute({
      callId: "write_1",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      toolName: "edit",
    });
    const write2 = scheduler.execute({
      callId: "write_2",
      messageId: "message_1",
      params: {},
      sessionId: "session_1",
      signal: queuedAbort.signal,
      toolName: "edit",
    });

    await vi.waitFor(() => {
      expect(scheduler.getStatus("write_2")).toBe("queued");
    });
    queuedAbort.abort();
    await expect(write2).resolves.toMatchObject({ status: "cancelled" });
    blocker.resolve({ output: "write_1" });
    await expect(write1).resolves.toMatchObject({ status: "success" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
