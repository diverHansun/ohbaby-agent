import { describe, expect, it, vi } from "vitest";
import { runAgent } from "./runner.js";
import type {
  AgentRunCoordinator,
  AgentRunDeps,
  AgentRunInput,
} from "./types.js";
import type { ChatCompletionMessage } from "../llm-client/index.js";
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
  const manager: MessageManager = {
    appendPart,
    createMessage,
    listBySession,
    removeMessage: vi.fn((): Promise<void> => Promise.resolve()),
    removeMessages: vi.fn((): Promise<void> => Promise.resolve()),
    toModelMessages: vi.fn((): Promise<ChatCompletionMessage[]> => Promise.resolve([])),
    updateMessage: vi.fn((): Promise<CoreMessage> => Promise.resolve(userMessage("updated"))),
    updatePart: vi.fn((): Promise<Part> => Promise.resolve({
      id: "updated_part",
      messageId: "updated",
      orderIndex: 0,
      sessionId: "session_child",
      text: "updated",
      type: "text",
    })),
  };
  return { appendPart, createMessage, listBySession, manager };
}

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
): ToolSchedulerInstance {
  return {
    cancel: vi.fn(),
    cancelAll: vi.fn(),
    execute: vi.fn(),
    executeBatch: vi.fn(),
    get: vi.fn(),
    getAvailableTools: vi.fn((): Promise<ToolDefinition[]> => Promise.resolve([...tools])),
    getCategory: vi.fn(),
    getPendingCalls: vi.fn(),
    getStatus: vi.fn(),
    register: vi.fn(),
    registerCategory: vi.fn(),
    unregister: vi.fn(),
  };
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
      createdAt: 1,
      disconnectMode: "continue",
      multitaskStrategy: "reject",
      permissionProfileId: "interactive",
      runId: "run_1",
      sessionId: "session_child",
      status: "pending",
      triggerSource: "user",
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

function baseInput(
  patch: Partial<AgentRunInput> = {},
): AgentRunInput {
  const modelMessages: readonly ChatCompletionMessage[] = [
    { role: "user", content: "hello" },
  ];
  return {
    agentName: "build",
    buildPromptMessages: vi.fn(
      (): Promise<readonly ChatCompletionMessage[]> =>
        Promise.resolve(modelMessages),
    ),
    initialUserPrompt: "hello",
    maxSteps: 5,
    parentSessionId: "session_parent",
    projectRoot: "D:/repo",
    sessionId: "session_child",
    waitMode: "waitForCompletion",
    ...patch,
  };
}

function createDeps(input: {
  readonly messageManager?: MessageManager;
  readonly runCoordinator?: AgentRunCoordinator;
  readonly sandboxManager?: AgentRunDeps["sandboxManager"];
  readonly toolScheduler?: ToolSchedulerInstance;
} = {}): AgentRunDeps {
  return {
    messageManager: input.messageManager ?? createMessageManager().manager,
    runCoordinator: input.runCoordinator ?? createRunCoordinator().coordinator,
    sandboxManager: input.sandboxManager,
    toolScheduler: input.toolScheduler ?? createToolScheduler(),
  };
}

describe("runAgent", () => {
  it("writes the initial user prompt, builds messages, starts a run, and returns final output", async () => {
    const messageManager = createMessageManager();
    const runCoordinator = createRunCoordinator();
    const toolScheduler = createToolScheduler();
    const sandboxManager = {
      setSessionEnvironment: vi.fn(),
    };
    const environment = { workdir: "D:/repo" } as ToolExecutionEnvironment;
    const input = baseInput({ environment });

    const result = await runAgent(
      createDeps({
        messageManager: messageManager.manager,
        runCoordinator: runCoordinator.coordinator,
        sandboxManager,
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
    expect(input.buildPromptMessages).toHaveBeenCalledWith({
      agentName: "build",
      isSubagent: true,
      projectRoot: "D:/repo",
      sessionId: "session_child",
    });
    expect(runCoordinator.create).toHaveBeenCalledWith({
      agent: "build",
      isSubagent: true,
      maxSteps: 5,
      messages: [{ role: "user", content: "hello" }],
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
    expect(sandboxManager.setSessionEnvironment).toHaveBeenNthCalledWith(
      1,
      "session_child",
      environment,
    );
    expect(sandboxManager.setSessionEnvironment).toHaveBeenNthCalledWith(
      2,
      "session_child",
      undefined,
    );
    expect(result).toMatchObject({
      finalOutput: "final answer",
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
      success: false,
    });
  });
});
