import { describe, expect, it, vi } from "vitest";
import type { MessageWithParts } from "../core/message/index.js";
import type {
  ToolExecutionContext,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import {
  MAX_TODO_CONTENT_LENGTH,
  MAX_TODO_ITEMS,
  TodoService,
  TodoWorkScopeRegistry,
  createTodoTools,
  goalTodoWorkScopeId,
  recoverTodosFromMessages,
  type TodoItem,
} from "./todo.js";

function createContext(
  sessionId: string,
  contextScopeId?: string,
): ToolExecutionContext {
  return {
    callId: "call_1",
    ...(contextScopeId === undefined ? {} : { contextScopeId }),
    messageId: "message_1",
    sessionId,
    signal: new AbortController().signal,
  };
}

function createToolRunner(store = new TodoService()): {
  readonly run: (
    name: string,
    params: Record<string, unknown>,
    context?: ToolExecutionContext,
  ) => Promise<
    Awaited<ReturnType<ReturnType<typeof createTodoTools>[number]["execute"]>>
  >;
  readonly store: TodoService;
} {
  const tools = createTodoTools(store);
  return {
    async run(
      name,
      params,
      context = createContext("session_1"),
    ): Promise<ToolExecutionResult> {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Tool not found in test: ${name}`);
      return await tool.execute(params, context);
    },
    store,
  };
}

function toolMessage(input: {
  readonly callId: string;
  readonly contextScopeId?: string;
  readonly state:
    | {
        readonly status: "completed";
        readonly input: Record<string, unknown>;
        readonly metadata?: Record<string, unknown>;
        readonly output: string;
      }
    | {
        readonly status: "error";
        readonly input: Record<string, unknown>;
        readonly error: string;
      }
    | {
        readonly status: "aborted";
        readonly input: Record<string, unknown>;
        readonly error: "Tool execution aborted by user";
      };
}): MessageWithParts {
  return {
    info: {
      agent: "build",
      ...(input.contextScopeId === undefined
        ? {}
        : { contextScopeId: input.contextScopeId }),
      id: `message_${input.callId}`,
      role: "assistant",
      sessionId: "session_1",
      time: { created: 1, completed: 2 },
    },
    parts: [
      {
        callId: input.callId,
        ...(input.contextScopeId === undefined
          ? {}
          : { contextScopeId: input.contextScopeId }),
        id: `part_${input.callId}`,
        messageId: `message_${input.callId}`,
        orderIndex: 0,
        sessionId: "session_1",
        state: input.state,
        tool: "todo_write",
        type: "tool",
      },
    ],
  };
}

describe("todo builtin tools", () => {
  it("writes and reads minimal todos scoped by session", async () => {
    const runner = createToolRunner();

    const write = await runner.run("todo_write", {
      todos: [
        { content: "Wire file tools", status: "in_progress" },
        { content: "Review bash tool", status: "in_progress" },
        { content: "Run tests", status: "pending" },
      ],
    });
    const sameSession = await runner.run("todo_read", {});
    const otherSession = await runner.run(
      "todo_read",
      {},
      createContext("session_2"),
    );

    expect(write.output).toContain("[in_progress] Wire file tools");
    expect(sameSession.output).toContain("[pending] Run tests");
    expect(sameSession.metadata).toMatchObject({ count: 3 });
    expect(otherSession.output).toBe("No todos.");
  });

  it("isolates todo lists by context scope within one session", async () => {
    const onWrite = vi.fn();
    const runner = createToolRunner(new TodoService({ onWrite }));

    await runner.run(
      "todo_write",
      { todos: [{ content: "Child A", status: "in_progress" }] },
      createContext("session_1", "scope_a"),
    );
    await runner.run(
      "todo_write",
      { todos: [{ content: "Child B", status: "pending" }] },
      createContext("session_1", "scope_b"),
    );

    expect(
      (await runner.run("todo_read", {}, createContext("session_1", "scope_a")))
        .output,
    ).toContain("Child A");
    expect(
      (await runner.run("todo_read", {}, createContext("session_1", "scope_b")))
        .output,
    ).toContain("Child B");
    expect((await runner.run("todo_read", {})).output).toBe("No todos.");
    expect(onWrite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ contextScopeId: "scope_a" }),
    );
    expect(onWrite).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ contextScopeId: "scope_b" }),
    );
  });

  it("isolates ordinary and goal-owned todo lists without exposing scope parameters", async () => {
    const onWrite = vi.fn();
    const store = new TodoService({ onWrite });
    const scopes = new TodoWorkScopeRegistry();
    const tools = createTodoTools(store, {
      resolveWorkScopeId: (context) => scopes.resolve(context.sessionId),
    });
    const run = async (
      name: string,
      params: Record<string, unknown>,
    ): Promise<ToolExecutionResult> => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Tool not found in test: ${name}`);
      return await tool.execute(params, createContext("session_1"));
    };

    const ordinaryLease = scopes.acquire("session_1");
    await run("todo_write", {
      todos: [{ content: "Ordinary", status: "pending" }],
    });
    ordinaryLease.release();

    const goalScope = goalTodoWorkScopeId("goal_a");
    const goalLease = scopes.acquire("session_1", goalScope);
    const goalWrite = await run("todo_write", {
      todos: [{ content: "Goal A", status: "in_progress" }],
    });
    expect((await run("todo_read", {})).output).toContain("Goal A");
    expect(goalWrite.metadata).toMatchObject({
      internalWorkScopeId: goalScope,
    });
    goalLease.release();

    const nextOrdinaryLease = scopes.acquire("session_1");
    expect((await run("todo_read", {})).output).toContain("Ordinary");
    nextOrdinaryLease.release();
    expect(onWrite).toHaveBeenLastCalledWith(
      expect.objectContaining({ workScopeId: goalScope }),
    );
    expect(
      tools.find((tool) => tool.name === "todo_write")?.parametersJsonSchema,
    ).not.toHaveProperty("properties.goalId");
    expect(
      tools.find((tool) => tool.name === "todo_write")?.parametersJsonSchema,
    ).not.toHaveProperty("properties.workScopeId");
  });

  it("keeps subagent context scope isolated from an active goal scope", async () => {
    const store = new TodoService();
    const scopes = new TodoWorkScopeRegistry();
    const goalScope = goalTodoWorkScopeId("goal_a");
    const lease = scopes.acquire("session_1", goalScope);
    const tools = createTodoTools(store, {
      resolveWorkScopeId: (context) => scopes.resolve(context.sessionId),
    });
    const write = tools.find((tool) => tool.name === "todo_write");
    if (!write) throw new Error("todo_write missing");

    await write.execute(
      { todos: [{ content: "Child", status: "pending" }] },
      createContext("session_1", "subagent_1"),
    );

    await expect(store.read("session_1", "subagent_1")).resolves.toEqual([
      { content: "Child", status: "pending" },
    ]);
    await expect(
      store.read("session_1", undefined, goalScope),
    ).resolves.toEqual([]);
    lease.release();
  });

  it("does not let an older lease release a newer binding", () => {
    const scopes = new TodoWorkScopeRegistry();
    const first = scopes.acquire("session_1", goalTodoWorkScopeId("goal_a"));
    const secondScope = goalTodoWorkScopeId("goal_b");
    const second = scopes.acquire("session_1", secondScope);

    first.release();
    expect(scopes.resolve("session_1")).toBe(secondScope);
    second.release();
    expect(scopes.resolve("session_1")).toBeUndefined();
  });

  it("trims content and accepts the 10 item and 100 code-point boundaries", async () => {
    const runner = createToolRunner();
    const content = "😀".repeat(MAX_TODO_CONTENT_LENGTH);
    const todos = Array.from({ length: MAX_TODO_ITEMS }, (_, index) => ({
      content: index === 0 ? `  ${content}  ` : `Task ${String(index + 1)}`,
      status: "pending" as const,
    }));

    const result = await runner.run("todo_write", { todos });
    const stored = result.metadata?.todos as TodoItem[];

    expect(stored).toHaveLength(MAX_TODO_ITEMS);
    expect(stored[0]?.content).toBe(content);
  });

  it.each([
    {
      label: "an eleventh item",
      todos: Array.from({ length: MAX_TODO_ITEMS + 1 }, (_, index) => ({
        content: `Task ${String(index + 1)}`,
        status: "pending",
      })),
    },
    {
      label: "101 Unicode code points",
      todos: [
        {
          content: "😀".repeat(MAX_TODO_CONTENT_LENGTH + 1),
          status: "pending",
        },
      ],
    },
    { label: "blank content", todos: [{ content: "   ", status: "pending" }] },
    {
      label: "a removed status",
      todos: [{ content: "Old task", status: "cancelled" }],
    },
    {
      label: "an id field",
      todos: [{ content: "Task", id: "todo_1", status: "pending" }],
    },
    {
      label: "a priority field",
      todos: [{ content: "Task", priority: "high", status: "pending" }],
    },
  ])("atomically rejects $label", async ({ todos }) => {
    const onWrite = vi.fn();
    const runner = createToolRunner(new TodoService({ onWrite }));
    await runner.run("todo_write", {
      todos: [{ content: "Original", status: "in_progress" }],
    });
    onWrite.mockClear();

    await expect(runner.run("todo_write", { todos })).rejects.toThrow();

    expect(await runner.store.read("session_1")).toEqual([
      { content: "Original", status: "in_progress" },
    ]);
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("reports repeated writes without marking the list changed", async () => {
    const onWrite = vi.fn();
    const runner = createToolRunner(new TodoService({ onWrite }));
    const todos = [{ content: "Same", status: "pending" as const }];

    await runner.run("todo_write", { todos });
    await runner.run("todo_write", { todos });

    expect(onWrite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ changed: true }),
    );
    expect(onWrite).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ changed: false }),
    );
  });

  it("treats an empty write as loaded state and does not resurrect history", async () => {
    const history = {
      listBySession: vi.fn().mockResolvedValue([
        toolMessage({
          callId: "old",
          state: {
            input: { todos: [{ content: "Old", status: "pending" }] },
            output: "ok",
            status: "completed",
          },
        }),
      ]),
    };
    const service = new TodoService({ history });

    service.write("session_1", []);

    await expect(service.read("session_1")).resolves.toEqual([]);
    expect(history.listBySession).not.toHaveBeenCalled();
  });

  it("does not expose mutable session state through metadata", async () => {
    const runner = createToolRunner();
    await runner.run("todo_write", {
      todos: [{ content: "Original", status: "pending" }],
    });

    const read = await runner.run("todo_read", {});
    const exposedTodos = read.metadata?.todos as TodoItem[];
    exposedTodos[0] = { content: "Mutated", status: "completed" };

    expect((await runner.run("todo_read", {})).output).toContain("Original");
  });

  it("declares read and write scheduler categories", () => {
    const tools = createTodoTools();

    expect(tools.find((tool) => tool.name === "todo_read")?.category).toBe(
      "readonly",
    );
    expect(tools.find((tool) => tool.name === "todo_write")?.category).toBe(
      "write",
    );
  });

  it("keeps tool descriptions limited to interface semantics", () => {
    const tools = createTodoTools();

    expect(tools.find((tool) => tool.name === "todo_read")?.description).toBe(
      "Read the todo list for the current task.",
    );
    expect(tools.find((tool) => tool.name === "todo_write")?.description).toBe(
      "Replace the todo list for the current task with a complete ordered list. Maximum 10 items; an empty list clears it.",
    );
  });
});

describe("todo history recovery", () => {
  it("recovers primary and child context histories independently", async () => {
    const primary = toolMessage({
      callId: "primary",
      state: {
        input: { todos: [{ content: "Primary", status: "pending" }] },
        output: "ok",
        status: "completed",
      },
    });
    const child = toolMessage({
      callId: "child",
      contextScopeId: "scope_a",
      state: {
        input: { todos: [{ content: "Child", status: "in_progress" }] },
        output: "ok",
        status: "completed",
      },
    });
    const history = {
      listBySession: vi.fn(
        (_sessionId: string, options?: { readonly contextScopeId?: string }) =>
          Promise.resolve(
            options?.contextScopeId === "scope_a" ? [child] : [primary, child],
          ),
      ),
    };
    const service = new TodoService({ history });

    await expect(service.read("session_1")).resolves.toEqual([
      { content: "Primary", status: "pending" },
    ]);
    await expect(service.read("session_1", "scope_a")).resolves.toEqual([
      { content: "Child", status: "in_progress" },
    ]);
    expect(history.listBySession).toHaveBeenNthCalledWith(2, "session_1", {
      contextScopeId: "scope_a",
    });
  });

  it("recovers the latest completed write and skips later failed writes", () => {
    const messages = [
      toolMessage({
        callId: "success",
        state: {
          input: { todos: [{ content: "Keep", status: "in_progress" }] },
          output: "ok",
          status: "completed",
        },
      }),
      toolMessage({
        callId: "failed",
        state: {
          error: "invalid",
          input: { todos: [{ content: "Ignore", status: "pending" }] },
          status: "error",
        },
      }),
    ];

    expect(recoverTodosFromMessages(messages)).toEqual([
      { content: "Keep", status: "in_progress" },
    ]);
  });

  it("recovers ordinary and goal histories independently by result metadata", () => {
    const goalScope = goalTodoWorkScopeId("goal_a");
    const messages = [
      toolMessage({
        callId: "ordinary",
        state: {
          input: { todos: [{ content: "Ordinary", status: "pending" }] },
          output: "ok",
          status: "completed",
        },
      }),
      toolMessage({
        callId: "goal",
        state: {
          input: { todos: [{ content: "Goal A", status: "in_progress" }] },
          metadata: { internalWorkScopeId: goalScope },
          output: "ok",
          status: "completed",
        },
      }),
    ];

    expect(recoverTodosFromMessages(messages)).toEqual([
      { content: "Ordinary", status: "pending" },
    ]);
    expect(recoverTodosFromMessages(messages, undefined, goalScope)).toEqual([
      { content: "Goal A", status: "in_progress" },
    ]);
  });

  it("does not assign legacy unscoped history to a goal", () => {
    const messages = [
      toolMessage({
        callId: "legacy",
        state: {
          input: { todos: [{ content: "Legacy", status: "pending" }] },
          output: "ok",
          status: "completed",
        },
      }),
    ];

    expect(
      recoverTodosFromMessages(
        messages,
        undefined,
        goalTodoWorkScopeId("goal_a"),
      ),
    ).toEqual([]);
  });

  it("treats a completed empty write as the final fact", () => {
    const messages = [
      toolMessage({
        callId: "old",
        state: {
          input: { todos: [{ content: "Old", status: "pending" }] },
          output: "ok",
          status: "completed",
        },
      }),
      toolMessage({
        callId: "clear",
        state: { input: { todos: [] }, output: "ok", status: "completed" },
      }),
    ];

    expect(recoverTodosFromMessages(messages)).toEqual([]);
  });

  it("warns about invalid completed candidates and continues backwards", () => {
    const onWarning = vi.fn();
    const messages = [
      toolMessage({
        callId: "valid",
        state: {
          input: { todos: [{ content: "Valid", status: "pending" }] },
          output: "ok",
          status: "completed",
        },
      }),
      toolMessage({
        callId: "invalid",
        state: {
          input: {
            todos: [{ content: "Legacy", id: "todo_1", status: "pending" }],
          },
          output: "ok",
          status: "completed",
        },
      }),
    ];

    expect(recoverTodosFromMessages(messages, onWarning)).toEqual([
      { content: "Valid", status: "pending" },
    ]);
    expect(onWarning).toHaveBeenCalledOnce();
  });

  it("does not let a slow recovery overwrite a newer write", async () => {
    let resolveHistory!: (messages: readonly MessageWithParts[]) => void;
    const service = new TodoService({
      history: {
        listBySession: (): Promise<readonly MessageWithParts[]> =>
          new Promise((resolve) => {
            resolveHistory = resolve;
          }),
      },
    });

    const reading = service.read("session_1");
    service.write("session_1", [{ content: "New", status: "in_progress" }]);
    resolveHistory([
      toolMessage({
        callId: "old",
        state: {
          input: { todos: [{ content: "Old", status: "pending" }] },
          output: "ok",
          status: "completed",
        },
      }),
    ]);

    await expect(reading).resolves.toEqual([
      { content: "New", status: "in_progress" },
    ]);
    await expect(service.read("session_1")).resolves.toEqual([
      { content: "New", status: "in_progress" },
    ]);
  });

  it("does not repopulate a released session from an in-flight recovery", async () => {
    let resolveFirstHistory!: (messages: readonly MessageWithParts[]) => void;
    const history = {
      listBySession: vi
        .fn()
        .mockImplementationOnce(
          (): Promise<readonly MessageWithParts[]> =>
            new Promise((resolve) => {
              resolveFirstHistory = resolve;
            }),
        )
        .mockResolvedValueOnce([
          toolMessage({
            callId: "fresh",
            state: {
              input: { todos: [{ content: "Fresh", status: "pending" }] },
              output: "ok",
              status: "completed",
            },
          }),
        ]),
    };
    const service = new TodoService({ history });

    const staleRead = service.read("session_1");
    service.release("session_1");
    resolveFirstHistory([
      toolMessage({
        callId: "stale",
        state: {
          input: { todos: [{ content: "Stale", status: "pending" }] },
          output: "ok",
          status: "completed",
        },
      }),
    ]);

    await expect(staleRead).resolves.toEqual([]);
    await expect(service.read("session_1")).resolves.toEqual([
      { content: "Fresh", status: "pending" },
    ]);
    expect(history.listBySession).toHaveBeenCalledTimes(2);
  });

  it("releases all context scopes for a session", async () => {
    const service = new TodoService();
    service.write("session_1", [{ content: "Primary", status: "pending" }]);
    service.write(
      "session_1",
      [{ content: "Child", status: "pending" }],
      "scope_a",
    );

    service.release("session_1");

    await expect(service.read("session_1")).resolves.toEqual([]);
    await expect(service.read("session_1", "scope_a")).resolves.toEqual([]);
  });

  it("releases one context scope without disrupting its siblings", async () => {
    const service = new TodoService();
    service.write("session_1", [{ content: "Primary", status: "pending" }]);
    service.write(
      "session_1",
      [{ content: "Child A", status: "pending" }],
      "scope_a",
    );
    service.write(
      "session_1",
      [{ content: "Child B", status: "pending" }],
      "scope_b",
    );

    service.releaseScope("session_1", "scope_a");

    await expect(service.read("session_1", "scope_a")).resolves.toEqual([]);
    await expect(service.read("session_1")).resolves.toEqual([
      { content: "Primary", status: "pending" },
    ]);
    await expect(service.read("session_1", "scope_b")).resolves.toEqual([
      { content: "Child B", status: "pending" },
    ]);
  });
});
