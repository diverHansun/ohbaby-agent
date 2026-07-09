import { describe, expect, it, vi } from "vitest";
import { runAgent } from "./runner.js";
import type {
  AgentRunCompletion,
  AgentRunCoordinator,
  AgentRunDeps,
  AgentRunInput,
  AgentRunEventSource,
} from "./types.js";
import type {
  CoreMessage,
  MessageManager,
  MessageWithParts,
  Part,
} from "../message/index.js";
import type {
  ToolDefinition,
  ToolExecutionEnvironment,
  ToolSchedulerInstance,
} from "../tool-scheduler/index.js";
import { SessionRunBusyError } from "../../runtime/run-ledger/index.js";

function userMessage(id: string): CoreMessage {
  return {
    id,
    agent: "build",
    role: "user",
    sessionId: "session_child",
    time: { created: 1 },
  };
}

function assistantText(text: string): MessageWithParts {
  return {
    info: {
      id: "assistant_1",
      agent: "build",
      role: "assistant",
      sessionId: "session_child",
      time: { created: 2 },
    },
    parts: [
      {
        id: "part_1",
        messageId: "assistant_1",
        orderIndex: 0,
        sessionId: "session_child",
        text,
        type: "text",
      },
    ],
  };
}

interface MessageManagerFixture {
  readonly appendPart: ReturnType<typeof vi.fn>;
  readonly createMessage: ReturnType<typeof vi.fn>;
  readonly listBySession: ReturnType<typeof vi.fn>;
  readonly manager: MessageManager;
  readonly removeMessage: ReturnType<typeof vi.fn>;
}

function createMessageManager(
  messages: readonly MessageWithParts[] = [assistantText("final answer")],
): MessageManagerFixture {
  const appendPart = vi.fn<MessageManager["appendPart"]>(
    (messageId, input): Promise<Part> => {
      if (input.type === "tool") {
        return Promise.resolve({
          callId: input.callId,
          id: "part_user",
          messageId,
          orderIndex: 0,
          sessionId: "session_child",
          state: input.state,
          tool: input.tool,
          type: "tool",
        });
      }
      return Promise.resolve({
        id: "part_user",
        messageId,
        orderIndex: 0,
        sessionId: "session_child",
        text: input.text,
        type: input.type,
      });
    },
  );
  const createMessage = vi.fn<MessageManager["createMessage"]>(
    (): Promise<CoreMessage> => Promise.resolve(userMessage("user_1")),
  );
  const listBySession = vi.fn<MessageManager["listBySession"]>(
    (): Promise<MessageWithParts[]> => Promise.resolve([...messages]),
  );
  const removeMessage = vi.fn((): Promise<void> => Promise.resolve());
  const manager: MessageManager = {
    appendPart,
    createMessage,
    listBySession,
    removeMessage,
    removeMessages: vi.fn((): Promise<void> => Promise.resolve()),
    toModelMessages: vi.fn(() => Promise.resolve([])),
    updateMessage: vi.fn(
      (): Promise<CoreMessage> => Promise.resolve(userMessage("updated")),
    ),
    updatePart: vi.fn(
      (): Promise<Part> =>
        Promise.resolve({
          id: "updated_part",
          messageId: "updated",
          orderIndex: 0,
          sessionId: "session_child",
          text: "updated",
          type: "text",
        }),
    ),
  };
  return { appendPart, createMessage, listBySession, manager, removeMessage };
}

type MockToolScheduler = ToolSchedulerInstance & {
  readonly getAvailableTools: ReturnType<
    typeof vi.fn<ToolSchedulerInstance["getAvailableTools"]>
  >;
};

function createToolScheduler(
  tools: readonly ToolDefinition[] = [
    {
      category: "readonly",
      description: "Run a shell command",
      name: "bash",
      parameters: { type: "object" },
      source: "builtin",
    },
  ],
): MockToolScheduler {
  const getAvailableTools = vi.fn<ToolSchedulerInstance["getAvailableTools"]>(
    (): Promise<ToolDefinition[]> => Promise.resolve([...tools]),
  );
  return {
    cancel: vi.fn(),
    cancelAll: vi.fn(),
    execute: vi.fn(),
    executeBatch: vi.fn(),
    get: vi.fn(),
    getAvailableTools,
    getCategory: vi.fn(),
    getPendingCalls: vi.fn(),
    getStatus: vi.fn(),
    register: vi.fn(),
    registerCategory: vi.fn(),
    unregister: vi.fn(),
  };
}

async function collectAsync<T>(input: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of input) {
    values.push(value);
  }
  return values;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface RunCoordinatorFixture {
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly coordinator: AgentRunCoordinator;
  readonly create: ReturnType<typeof vi.fn>;
  readonly waitForCompletion: ReturnType<typeof vi.fn>;
}

function createRunCoordinator(
  completion: Awaited<ReturnType<AgentRunCoordinator["waitForCompletion"]>> = {
    status: "succeeded",
  },
): RunCoordinatorFixture {
  const cancel = vi.fn<AgentRunCoordinator["cancel"]>();
  const create = vi.fn<AgentRunCoordinator["create"]>(() =>
    Promise.resolve({
      runId: "run_1",
      sessionId: "session_child",
    }),
  );
  const waitForCompletion = vi.fn<AgentRunCoordinator["waitForCompletion"]>(
    () => Promise.resolve(completion),
  );
  return {
    cancel,
    coordinator: {
      cancel,
      create,
      waitForCompletion,
    },
    create,
    waitForCompletion,
  };
}

function baseInput(patch: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    agentName: "build",
    initialUserPrompt: "hello",
    maxSteps: 5,
    modelId: "fake-model",
    parentSessionId: "session_parent",
    projectRoot: "D:/repo",
    sessionId: "session_child",
    waitMode: "waitForCompletion",
    ...patch,
  };
}

function createDeps(
  input: {
    readonly messageManager?: MessageManager;
    readonly runEventSource?: AgentRunEventSource;
    readonly runCoordinator?: AgentRunCoordinator;
    readonly toolScheduler?: ToolSchedulerInstance;
  } = {},
): AgentRunDeps {
  return {
    messageManager: input.messageManager ?? createMessageManager().manager,
    runEventSource: input.runEventSource,
    runCoordinator: input.runCoordinator ?? createRunCoordinator().coordinator,
    toolScheduler: input.toolScheduler ?? createToolScheduler(),
  };
}

describe("runAgent", () => {
  it("writes the initial user prompt, starts a session run, and returns final output", async () => {
    const messageManager = createMessageManager();
    const runCoordinator = createRunCoordinator();
    const toolScheduler = createToolScheduler();
    const environment = { workdir: "D:/repo" } as ToolExecutionEnvironment;
    const input = baseInput({ environment });

    const result = await runAgent(
      createDeps({
        messageManager: messageManager.manager,
        runCoordinator: runCoordinator.coordinator,
        toolScheduler,
      }),
      input,
    );

    expect(messageManager.createMessage).toHaveBeenCalledWith({
      agent: "build",
      role: "user",
      sessionId: "session_child",
    });
    expect(messageManager.appendPart).toHaveBeenCalledWith("user_1", {
      text: "hello",
      type: "text",
    });
    expect(runCoordinator.create).toHaveBeenCalledWith({
      agent: "build",
      directory: "D:/repo",
      isSubagent: true,
      maxSteps: 5,
      modelId: "fake-model",
      parentMessageId: "user_1",
      sessionId: "session_child",
      tools: [
        {
          function: {
            description: "Run a shell command",
            name: "bash",
            parameters: { type: "object" },
          },
          type: "function",
        },
      ],
      triggerSource: "user",
    });
    expect(runCoordinator.waitForCompletion).toHaveBeenCalledWith("run_1");
    expect(messageManager.listBySession).toHaveBeenCalledWith("session_child");
    expect(result).toMatchObject({
      finalOutput: "final answer",
      mode: "waitForCompletion",
      sessionId: "session_child",
      success: true,
    });
  });

  it("uses an explicit parent message id when no initial prompt is provided", async () => {
    const messageManager = createMessageManager();
    const runCoordinator = createRunCoordinator();

    await runAgent(
      createDeps({
        messageManager: messageManager.manager,
        runCoordinator: runCoordinator.coordinator,
      }),
      baseInput({
        initialUserPrompt: undefined,
        parentMessageId: "parent_message",
        parentSessionId: undefined,
      }),
    );

    expect(messageManager.createMessage).not.toHaveBeenCalled();
    expect(runCoordinator.create).toHaveBeenCalledWith(
      expect.objectContaining({
        isSubagent: false,
        parentMessageId: "parent_message",
      }),
    );
  });

  it("uses explicit instance scope for subagent identity and message queries", async () => {
    const messageManager = createMessageManager();
    const runCoordinator = createRunCoordinator();
    const toolScheduler = createToolScheduler();

    await runAgent(
      createDeps({
        messageManager: messageManager.manager,
        runCoordinator: runCoordinator.coordinator,
        toolScheduler,
      }),
      baseInput({
        agentInstanceId: "subagent_1",
        contextScopeId: "subagent_1",
        isSubagent: true,
        parentSessionId: undefined,
      }),
    );

    expect(messageManager.createMessage).toHaveBeenCalledWith({
      agent: "build",
      contextScopeId: "subagent_1",
      role: "user",
      sessionId: "session_child",
    });
    expect(runCoordinator.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentInstanceId: "subagent_1",
        contextScopeId: "subagent_1",
        isSubagent: true,
      }),
    );
    expect(toolScheduler.getAvailableTools).toHaveBeenCalledWith({
      agentName: "build",
      isSubagent: true,
    });
    expect(messageManager.listBySession).toHaveBeenCalledWith("session_child", {
      contextScopeId: "subagent_1",
    });
  });

  it("removes the initial user message when run creation fails", async () => {
    const messageManager = createMessageManager();
    const runCoordinator = createRunCoordinator();
    runCoordinator.create.mockRejectedValue(
      new SessionRunBusyError("session_child", ["run_active"]),
    );

    await expect(
      runAgent(
        createDeps({
          messageManager: messageManager.manager,
          runCoordinator: runCoordinator.coordinator,
        }),
        baseInput(),
      ),
    ).rejects.toBeInstanceOf(SessionRunBusyError);

    expect(messageManager.createMessage).toHaveBeenCalledTimes(1);
    expect(messageManager.appendPart).toHaveBeenCalledTimes(1);
    expect(messageManager.removeMessage).toHaveBeenCalledWith("user_1");
    expect(runCoordinator.waitForCompletion).not.toHaveBeenCalled();
    expect(messageManager.listBySession).not.toHaveBeenCalled();
  });

  it("preserves the run creation error when initial user message cleanup fails", async () => {
    const messageManager = createMessageManager();
    const runCoordinator = createRunCoordinator();
    const busyError = new SessionRunBusyError("session_child", ["run_active"]);
    runCoordinator.create.mockRejectedValue(busyError);
    messageManager.removeMessage.mockRejectedValue(new Error("cleanup failed"));

    await expect(
      runAgent(
        createDeps({
          messageManager: messageManager.manager,
          runCoordinator: runCoordinator.coordinator,
        }),
        baseInput(),
      ),
    ).rejects.toBe(busyError);

    expect(messageManager.removeMessage).toHaveBeenCalledWith("user_1");
    expect(runCoordinator.waitForCompletion).not.toHaveBeenCalled();
    expect(messageManager.listBySession).not.toHaveBeenCalled();
  });

  it("cancels the run when the caller aborts", async () => {
    const runCoordinator = createRunCoordinator({ status: "cancelled" });
    const abortController = new AbortController();

    const promise = runAgent(
      createDeps({ runCoordinator: runCoordinator.coordinator }),
      baseInput({ signal: abortController.signal }),
    );
    abortController.abort("stop");
    const result = await promise;

    expect(runCoordinator.cancel).toHaveBeenCalledWith("run_1", "stop");
    expect(result).toMatchObject({
      error: "stop",
      mode: "waitForCompletion",
      success: false,
    });
  });

  it("starts a run in stream mode, returns lifecycle events, and cleans up after completion", async () => {
    const runCoordinator = createRunCoordinator();
    const completion = deferred<AgentRunCompletion>();
    runCoordinator.waitForCompletion.mockImplementation(
      () => completion.promise,
    );
    const event = {
      content: "hello",
      completeMessage: { content: "hello", role: "assistant" },
      delta: "hello",
      sessionId: "session_child",
      timestamp: 1,
      type: "llm:delta",
    } as const;
    const subscribeRunEvents = vi.fn<AgentRunEventSource["subscribeRunEvents"]>(
      (): AsyncIterable<typeof event> =>
        (async function* (): AsyncIterable<typeof event> {
          await Promise.resolve();
          yield event;
        })(),
    );
    const runEventSource: AgentRunEventSource = { subscribeRunEvents };
    const environment = { workdir: "D:/repo" } as ToolExecutionEnvironment;

    const result = await runAgent(
      createDeps({
        runCoordinator: runCoordinator.coordinator,
        runEventSource,
      }),
      baseInput({ environment, waitMode: "stream" }),
    );

    expect(result.mode).toBe("stream");
    if (result.mode !== "stream") {
      throw new Error("Expected stream mode result");
    }
    expect(result).toMatchObject({
      runId: "run_1",
      sessionId: "session_child",
    });
    expect(subscribeRunEvents).toHaveBeenCalledWith("run_1");
    expect(runCoordinator.create).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: "D:/repo",
      }),
    );
    await expect(collectAsync(result.events)).resolves.toEqual([event]);
    completion.resolve({ status: "succeeded" });
  });

  it("subscribes before creating a streaming run when the run id is known", async () => {
    const callOrder: string[] = [];
    const runCoordinator = createRunCoordinator();
    runCoordinator.create.mockImplementation(() => {
      callOrder.push("create");
      return Promise.resolve({
        runId: "run_known",
        sessionId: "session_child",
      });
    });
    const subscribeRunEvents = vi.fn<AgentRunEventSource["subscribeRunEvents"]>(
      (): AsyncIterable<never> => {
        callOrder.push("subscribe");
        return {
          [Symbol.asyncIterator](): AsyncIterator<never> {
            return {
              next(): Promise<IteratorResult<never>> {
                return Promise.resolve({
                  done: true,
                  value: undefined as never,
                });
              },
            };
          },
        };
      },
    );

    await runAgent(
      createDeps({
        runCoordinator: runCoordinator.coordinator,
        runEventSource: { subscribeRunEvents },
      }),
      baseInput({ runId: "run_known", waitMode: "stream" }),
    );

    expect(callOrder).toEqual(["subscribe", "create"]);
    expect(runCoordinator.create).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run_known" }),
    );
  });
});
