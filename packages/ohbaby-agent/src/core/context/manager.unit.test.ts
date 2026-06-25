import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../message/index.js";
import type {
  MessageIdGenerator,
  MessageManager,
  MessageWithParts,
} from "../message/index.js";
import {
  ContextEvent,
  createContextManager,
  decideCompactionRung,
  findCutPoint,
  getContextUsage,
} from "./index.js";
import type {
  ContextLLMClient,
  MemoryReader,
  SystemPromptProvider,
  TokenCounter,
} from "./types.js";
import { isActivePart } from "./filters.js";
import { serializeHistory } from "./serialization.js";
import { serializeForLlm } from "./serializer.js";
import { partitionSummary } from "./summary.js";
import { estimateWireHeuristic } from "./token-estimation.js";

interface ContextFixture {
  readonly compactSkipped: readonly unknown[];
  readonly compressed: readonly unknown[];
  readonly manager: ReturnType<typeof createContextManager>;
  readonly masked: readonly unknown[];
  readonly memory: MemoryReader;
  readonly pruned: readonly unknown[];
  readonly systemPromptProvider: SystemPromptProvider;
}

function createMessageIds(): MessageIdGenerator {
  let nextMessageId = 1;
  let nextPartId = 1;

  return {
    messageId(): string {
      const id = `message_${String(nextMessageId)}`;
      nextMessageId += 1;
      return id;
    },
    partId(): string {
      const id = `part_${String(nextPartId)}`;
      nextPartId += 1;
      return id;
    },
  };
}

function createClock(): () => number {
  let now = 1_000;

  return () => {
    const current = now;
    now += 1_000;
    return current;
  };
}

function createMessageManagerFixture(): MessageManager {
  return createMessageManager({
    bus: createBus(),
    store: createInMemoryMessageStore(),
    idGenerator: createMessageIds(),
    now: createClock(),
  });
}

function createTokenCounter(): TokenCounter {
  return {
    estimateTokens(content: string): number {
      return content.length;
    },
    getLimit(): number {
      return 100;
    },
  };
}

function messageWithText(
  role: "user" | "assistant",
  text: string,
  metadata?: Record<string, unknown>,
  created = 1,
): MessageWithParts {
  const id = `${role}_${text}`;
  return {
    info: {
      agent: "test",
      id,
      role,
      sessionId: "session_1",
      time: { created },
    },
    parts: [
      {
        id: `part_${id}`,
        messageId: id,
        metadata,
        orderIndex: 0,
        sessionId: "session_1",
        text,
        type: "text",
      },
    ],
  };
}

function messageWithCompletedTool(input: {
  readonly callId: string;
  readonly id: string;
  readonly output: string;
  readonly path: string;
  readonly tool: string;
}): MessageWithParts {
  return {
    info: {
      agent: "test",
      id: input.id,
      role: "assistant",
      sessionId: "session_1",
      time: { created: 1 },
    },
    parts: [
      {
        callId: input.callId,
        id: `part_${input.id}`,
        messageId: input.id,
        orderIndex: 0,
        sessionId: "session_1",
        state: {
          input: { path: input.path },
          output: input.output,
          status: "completed",
        },
        tool: input.tool,
        type: "tool",
      },
    ],
  };
}

function createManager(
  options: {
    readonly messageManager?: MessageManager;
    readonly memory?: MemoryReader;
    readonly tokenCounter?: TokenCounter;
    readonly llmClient?: ContextLLMClient;
    readonly now?: () => number;
    readonly compressionThreshold?: number;
    readonly maskEnabled?: boolean;
    readonly maskConfig?: Parameters<typeof createContextManager>[0]["maskConfig"];
    readonly pruneProtectTokens?: number;
    readonly pruneMinimumTokens?: number;
  } = {},
): ContextFixture {
  const bus = createBus();
  const compactSkipped: unknown[] = [];
  const compressed: unknown[] = [];
  const masked: unknown[] = [];
  const pruned: unknown[] = [];
  const memory =
    options.memory ??
    ({
      load: vi.fn().mockResolvedValue({
        global: "global memory",
        project: "project memory",
        merged: "global memory\n---\nproject memory",
      }),
    } satisfies MemoryReader);
  const systemPromptProvider: SystemPromptProvider = {
    build: vi.fn().mockResolvedValue("system prompt"),
  };
  const manager = createContextManager({
    bus,
    memory,
    messageManager: options.messageManager ?? createMessageManagerFixture(),
    systemPromptProvider,
    tokenCounter: options.tokenCounter ?? createTokenCounter(),
    llmClient:
      options.llmClient ??
      ({
        generateSummary: vi
          .fn()
          .mockResolvedValue("<state_snapshot>short</state_snapshot>"),
      } satisfies ContextLLMClient),
    now: options.now ?? createClock(),
    compressionThreshold: options.compressionThreshold,
    maskEnabled: options.maskEnabled,
    maskConfig: options.maskConfig,
    pruneProtectTokens: options.pruneProtectTokens ?? 10,
    pruneMinimumTokens: options.pruneMinimumTokens ?? 5,
  });

  bus.subscribe(ContextEvent.Compressed, (payload) => {
    compressed.push(payload);
  });
  bus.subscribe(ContextEvent.CompactSkipped, (payload) => {
    compactSkipped.push(payload);
  });
  bus.subscribe(ContextEvent.Pruned, (payload) => {
    pruned.push(payload);
  });
  bus.subscribe(ContextEvent.Masked, (payload) => {
    masked.push(payload);
  });

  return {
    compactSkipped,
    compressed,
    masked,
    manager,
    memory,
    pruned,
    systemPromptProvider,
  };
}

async function addTextMessage(
  messageManager: MessageManager,
  input: {
    readonly sessionId: string;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const message = await messageManager.createMessage({
    sessionId: input.sessionId,
    role: input.role,
    agent: "test",
  });
  await messageManager.appendPart(message.id, {
    type: "text",
    text: input.text,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  });
}

async function addCompletedToolMessage(
  messageManager: MessageManager,
  input: {
    readonly sessionId: string;
    readonly output: string;
  },
): Promise<void> {
  const message = await messageManager.createMessage({
    sessionId: input.sessionId,
    role: "assistant",
    agent: "test",
  });
  await messageManager.appendPart(message.id, {
    type: "tool",
    callId: `${message.id}_call`,
    tool: "read_file",
    state: {
      status: "completed",
      input: {},
      output: input.output,
    },
  });
}

async function summaryMessageCount(
  messageManager: MessageManager,
  sessionId: string,
): Promise<number> {
  const history = await messageManager.listBySession(sessionId);
  return history.filter((message) =>
    message.parts.some((part) => part.metadata?.kind === "context-summary"),
  ).length;
}

describe("ContextManager", () => {
  it("estimates wire heuristic from the full provider payload", () => {
    const messages = [
      { role: "system" as const, content: "system prompt" },
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "answer" },
    ];

    expect(
      estimateWireHeuristic(messages, {
        estimateTokens: (content: string) => content.length,
      }),
    ).toBe(messages.map((message) => JSON.stringify(message)).join("\n").length);
  });

  it("counts assistant tool calls even when message content is null", () => {
    const messages = [
      {
        content: null,
        role: "assistant" as const,
        tool_calls: [
          {
            function: {
              arguments:
                '{"path":"/a/very/long/path/with/many/chars.ts"}',
              name: "read_file",
            },
            id: "call_read",
            type: "function" as const,
          },
        ],
      },
    ];

    const tokens = estimateWireHeuristic(messages, {
      estimateTokens: (content: string) => content.length,
    });

    expect(tokens).toBeGreaterThan(20);
    expect(tokens).toBe(JSON.stringify(messages[0]).length);
  });

  it("finds a cut point on message boundaries around completed tool parts", () => {
    const cut = findCutPoint({
      history: [
        messageWithText("user", "start"),
        messageWithCompletedTool({
          callId: "call_1",
          id: "message_tool",
          output: "large output",
          path: "README.md",
          tool: "read_file",
        }),
        messageWithText("user", "recent"),
      ],
      keepRecentTokens: 5,
      tokenCounter: {
        estimateTokens: (content: string) => content.length,
      },
    });

    expect(cut.firstKeptIndex).toBe(2);
  });

  it("returns a turn prefix when the cut keeps an assistant suffix", () => {
    const currentUser = messageWithText("user", "current question");
    const currentAssistant = messageWithText("assistant", "current answer");
    const cut = findCutPoint({
      history: [
        messageWithText("user", "old question"),
        messageWithText("assistant", "old answer"),
        currentUser,
        currentAssistant,
      ],
      keepRecentTokens: "assistant: current answer".length,
      tokenCounter: {
        estimateTokens: (content: string) => content.length,
      },
    });

    expect(cut.firstKeptIndex).toBe(3);
    expect(cut.turnPrefixMessages.map((message) => message.info.id)).toEqual([
      currentUser.info.id,
    ]);
  });

  it("identifies active parts and partitions context summaries", async () => {
    expect(
      isActivePart({
        id: "part_active",
        messageId: "message_1",
        orderIndex: 0,
        sessionId: "session_1",
        text: "active",
        type: "text",
      }),
    ).toBe(true);
    expect(
      isActivePart({
        id: "part_compacted",
        messageId: "message_1",
        orderIndex: 1,
        sessionId: "session_1",
        text: "compacted",
        time: { compacted: 123 },
        type: "text",
      }),
    ).toBe(false);

    const messageManager = createMessageManagerFixture();
    const summary = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "context",
    });
    await messageManager.appendPart(summary.id, {
      type: "text",
      text: "summary",
      synthetic: true,
      metadata: { kind: "context-summary" },
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "latest",
    });

    const partition = partitionSummary(
      await messageManager.listBySession("session_1"),
    );

    expect(partition.summaries.map((message) => message.info.id)).toEqual([
      summary.id,
    ]);
    expect(partition.nonSummary.map((message) => message.info.id)).toEqual([
      "message_2",
    ]);
  });

  it("projects context summaries as user-wrapped summary blocks for LLM input", () => {
    const messages = serializeForLlm({
      history: [
        messageWithText("assistant", "## Goal\n- Continue compact work.", {
          kind: "context-summary",
        }),
        messageWithText("user", "continue"),
      ],
      isSubagent: false,
      memory: { global: "", project: "", merged: "" },
      systemPrompt: "",
    });

    expect(messages).toEqual([
      {
        role: "user",
        content:
          "<context_summary>\n## Goal\n- Continue compact work.\n</context_summary>",
      },
      { role: "user", content: "continue" },
    ]);
  });

  it("assembles system prompt, memory, and message history", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "hello",
    });
    const { manager } = createManager({
      messageManager,
      tokenCounter: {
        estimateTokens: (content: string) => content.length,
        getLimit: () => 10_000,
      },
    });

    const context = await manager.assemble("session_1", "D:/repo");

    expect(context.systemPrompt).toBe("system prompt");
    expect(context.memory.merged).toContain("global memory");
    expect(context.history).toHaveLength(1);
    expect(context.hasSummary).toBe(false);
    expect(context.estimatedTokens).toBeGreaterThan(0);
  });

  it("serializes tool parts as assistant tool calls followed by tool results", async () => {
    const messageManager = createMessageManagerFixture();
    const user = await messageManager.createMessage({
      sessionId: "session_1",
      role: "user",
      agent: "test",
    });
    await messageManager.appendPart(user.id, {
      type: "text",
      text: "read file",
    });
    const assistant = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "test",
    });
    await messageManager.appendPart(assistant.id, {
      type: "tool",
      callId: "call_read",
      tool: "read_file",
      state: {
        status: "completed",
        input: { path: "README.md" },
        output: "content",
      },
    });

    const { manager } = createManager({
      messageManager,
      tokenCounter: {
        estimateTokens: (content: string) => content.length,
        getLimit: () => 10_000,
      },
    });
    const context = await manager.assemble("session_1", "D:/repo");
    const messages = serializeForLlm({
      history: context.history,
      isSubagent: false,
      memory: { global: "", project: "", merged: "" },
      systemPrompt: "system prompt",
    });

    expect(messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "read file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_read",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"README.md"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_read", content: "content" },
    ]);
  });

  it("projects whitelisted tool metadata without leaking raw internals", async () => {
    const messageManager = createMessageManagerFixture();
    const assistant = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "test",
    });
    await messageManager.appendPart(assistant.id, {
      type: "tool",
      callId: "call_read",
      tool: "read",
      state: {
        status: "completed",
        input: { file_path: "README.md" },
        output: "content",
        metadata: {
          diff: "secret diff",
          hasMore: false,
          mtimeMs: 1234567890,
          path: "D:/repo/README.md",
          pid: 42,
          resolvedPaths: ["D:/repo/README.md"],
        },
      },
    });

    const history = await messageManager.listBySession("session_1");
    const messages = serializeForLlm({
      history,
      isSubagent: false,
      memory: { global: "", project: "", merged: "" },
      systemPrompt: "",
    });

    expect(messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_read",
            type: "function",
            function: {
              name: "read",
              arguments: '{"file_path":"README.md"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_read",
        content:
          'content\n\n<tool_metadata>\n{"path":"D:/repo/README.md","mtimeMs":1234567890,"hasMore":false}\n</tool_metadata>',
      },
    ]);
  });

  it("projects error metadata for empty bash output", () => {
    const messages = serializeForLlm({
      history: [
        {
          info: {
            agent: "test",
            id: "message_bash",
            role: "assistant",
            sessionId: "session_1",
            time: { created: 1 },
          },
          parts: [
            {
              callId: "call_bash",
              id: "part_bash",
              messageId: "message_bash",
              orderIndex: 0,
              sessionId: "session_1",
              state: {
                error: "",
                input: { command: "false" },
                metadata: {
                  exitCode: 1,
                  shell: "powershell",
                  signal: null,
                },
                status: "error",
              },
              tool: "bash",
              type: "tool",
            },
          ],
        },
      ],
      isSubagent: false,
      memory: { global: "", project: "", merged: "" },
      systemPrompt: "",
    });

    expect(messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_bash",
      content:
        '<tool_metadata>\n{"exitCode":1,"signal":null}\n</tool_metadata>',
    });
  });

  it("projects MCP structured content metadata", () => {
    const messages = serializeForLlm({
      history: [
        {
          info: {
            agent: "test",
            id: "message_mcp",
            role: "assistant",
            sessionId: "session_1",
            time: { created: 1 },
          },
          parts: [
            {
              callId: "call_mcp",
              id: "part_mcp",
              messageId: "message_mcp",
              orderIndex: 0,
              sessionId: "session_1",
              state: {
                input: { query: "ohbaby" },
                output: "search result",
                metadata: {
                  contentTypes: ["text"],
                  hasImage: true,
                  isError: false,
                  server: "search-server",
                  source: "mcp",
                  structuredContent: { total: 1 },
                  tool: "search",
                },
                status: "completed",
              },
              tool: "mcp_s13_search-server_t6_search",
              type: "tool",
            },
          ],
        },
      ],
      isSubagent: false,
      memory: { global: "", project: "", merged: "" },
      systemPrompt: "",
    });

    expect(messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_mcp",
      content:
        'search result\n\n<tool_metadata>\n{"server":"search-server","tool":"search","isError":false,"contentTypes":["text"],"structuredContent":{"total":1}}\n</tool_metadata>',
    });
  });

  it("keeps partial aborted tool output before the abort notice", () => {
    const messages = serializeForLlm({
      history: [
        {
          info: {
            agent: "test",
            id: "message_aborted_tool",
            role: "assistant",
            sessionId: "session_1",
            time: { created: 1 },
          },
          parts: [
            {
              callId: "call_bash",
              id: "part_aborted_bash",
              messageId: "message_aborted_tool",
              orderIndex: 0,
              sessionId: "session_1",
              state: {
                error: "Tool execution aborted by user",
                input: { command: "long-running-command" },
                output: "partial stdout before abort",
                status: "aborted",
              },
              tool: "bash",
              type: "tool",
            },
          ],
        },
      ],
      isSubagent: false,
      memory: { global: "", project: "", merged: "" },
      systemPrompt: "",
    });

    expect(messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_bash",
      content: "partial stdout before abort\n\nTool execution aborted by user",
    });
  });

  it("omits assistant messages finished with error from model input", () => {
    const messages = serializeForLlm({
      history: [
        messageWithText("user", "Try a large request"),
        {
          info: {
            agent: "test",
            error: {
              message: "maximum context length exceeded",
              name: "Unknown",
            },
            finish: "error",
            id: "assistant_failed",
            role: "assistant",
            sessionId: "session_1",
            time: { created: 1 },
          },
          parts: [
            {
              id: "part_failed",
              messageId: "assistant_failed",
              orderIndex: 0,
              sessionId: "session_1",
              text: "Partial failed answer",
              type: "text",
            },
          ],
        },
        messageWithText("user", "Retry after compaction"),
      ],
      isSubagent: false,
      memory: { global: "", project: "", merged: "" },
      systemPrompt: "system prompt",
    });

    expect(messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "Try a large request" },
      { role: "user", content: "Retry after compaction" },
    ]);
  });

  it("prepareTurn returns provider-ready messages without mutating below threshold", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "hello",
    });
    const { manager } = createManager({
      messageManager,
      tokenCounter: {
        estimateTokens: (content: string) => content.length,
        getLimit: () => 10_000,
      },
    });

    const prepared = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });

    expect(prepared.messages[0].role).toBe("system");
    expect(prepared.messages[0].content).toEqual(
      expect.stringContaining("system prompt"),
    );
    expect(prepared.compaction).toBeUndefined();
    expect(prepared.hasSummary).toBe(false);
    expect(prepared.sentHeuristic).toBeGreaterThan(0);
  });

  it("applies session calibration with EMA when measuring prepared turns", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "hello",
    });
    const { manager } = createManager({ messageManager });

    const baseline = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });
    manager.updateCalibrationFactor(
      "session_1",
      baseline.sentHeuristic * 2,
      baseline.sentHeuristic,
    );
    const calibrated = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });

    expect(calibrated.usage.currentTokens).toBe(
      Math.round(calibrated.sentHeuristic * 1.5),
    );
  });

  it("dark ships mask statistics without changing prepared messages by default", async () => {
    const messageManager = createMessageManagerFixture();
    await addCompletedToolMessage(messageManager, {
      sessionId: "session_1",
      output: "x".repeat(500),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "latest",
    });
    const { manager, masked } = createManager({
      compressionThreshold: 10,
      maskConfig: {
        minPartTokens: 1,
        minPrunableTokens: 1,
        minUsageRatio: 0.1,
        protectionTokens: 1,
      },
      messageManager,
      tokenCounter: {
        estimateTokens: (content: string) => content.length,
        getLimit: () => 1_000,
      },
    });

    const prepared = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });

    expect(prepared.messages).toContainEqual({
      content: "x".repeat(500),
      role: "tool",
      tool_call_id: "message_1_call",
    });
    expect(masked[0]).toMatchObject({
      enabled: false,
      maskedPartIds: ["part_1"],
      sessionId: "session_1",
    });
  });

  it("applies mask before usage measurement while keeping tool-call pairing", async () => {
    const messageManager = createMessageManagerFixture();
    await addCompletedToolMessage(messageManager, {
      sessionId: "session_1",
      output: "x".repeat(500),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "latest",
    });
    const { manager, masked } = createManager({
      compressionThreshold: 10,
      maskConfig: {
        minPartTokens: 1,
        minPrunableTokens: 1,
        minUsageRatio: 0.1,
        protectionTokens: 1,
      },
      maskEnabled: true,
      messageManager,
      tokenCounter: {
        estimateTokens: (content: string) => content.length,
        getLimit: () => 1_000,
      },
    });

    const prepared = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });

    expect(prepared.messages).toContainEqual({
      content: null,
      role: "assistant",
      tool_calls: [
        {
          function: {
            arguments: "{}",
            name: "read_file",
          },
          id: "message_1_call",
          type: "function",
        },
      ],
    });
    expect(prepared.messages).toContainEqual({
      content: "[Old tool result cleared (was ~500 tokens)]",
      role: "tool",
      tool_call_id: "message_1_call",
    });
    expect(prepared.usage.currentTokens).toBeLessThan(700);
    expect(masked[0]).toMatchObject({
      enabled: true,
      maskedPartIds: ["part_1"],
    });
  });

  it("lets mask delay prune-summary when reduced usage drops below the threshold", async () => {
    const messageManager = createMessageManagerFixture();
    await addCompletedToolMessage(messageManager, {
      sessionId: "session_1",
      output: "x".repeat(6_000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "latest",
    });
    const generateSummary = vi.fn<ContextLLMClient["generateSummary"]>();
    const { manager } = createManager({
      compressionThreshold: 0.5,
      llmClient: { generateSummary },
      maskConfig: {
        minPartTokens: 1,
        minPrunableTokens: 1,
        minUsageRatio: 0.5,
        protectionTokens: 1,
      },
      maskEnabled: true,
      messageManager,
      tokenCounter: {
        estimateTokens: (content: string) => content.length,
        getBudget(_modelId, options) {
          const usedInputTokens = options?.usedInputTokens ?? 0;
          return {
            contextWindowTokens: 12_000,
            inputBudgetTokens: 10_000,
            maxOutputTokens: 1_000,
            modelId: "model-a",
            remainingInputTokens: 10_000 - usedInputTokens,
            reservedOutputTokens: 1_000,
            safetyMarginTokens: 1_000,
            usageRatio: usedInputTokens / 10_000,
            usedInputTokens,
          };
        },
        getLimit: () => 12_000,
      },
    });

    const prepared = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });

    expect(prepared.compaction).toBeUndefined();
    expect(prepared.usage.usageRatio).toBeLessThan(0.5);
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it("keeps prepareTurn compaction path to two history reads and one memory load", async () => {
    const messageManager = createMessageManagerFixture();
    const listBySession = vi.spyOn(messageManager, "listBySession");
    const loadMemory = vi
      .fn<MemoryReader["load"]>()
      .mockResolvedValue({ global: "", project: "", merged: "" });
    const memory: MemoryReader = {
      load: loadMemory,
    };
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "first long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "second long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "third long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "fourth long text",
    });
    const { manager } = createManager({
      llmClient: {
        generateSummary: vi.fn().mockResolvedValue("## Goal\nshort"),
      },
      memory,
      messageManager,
    });

    const prepared = await manager.prepareTurn({
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
      sessionId: "session_1",
    });

    expect(prepared.compaction?.status).toBe("compacted");
    expect(listBySession).toHaveBeenCalledTimes(2);
    expect(loadMemory).toHaveBeenCalledTimes(1);
  });

  it("keeps prepareTurn prune-only path to one history read", async () => {
    const messageManager = createMessageManagerFixture();
    const memory: MemoryReader = {
      load: vi.fn().mockResolvedValue({ global: "", project: "", merged: "" }),
    };
    await addCompletedToolMessage(messageManager, {
      sessionId: "session_1",
      output: "x".repeat(80),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "small",
    });
    const listBySession = vi.spyOn(messageManager, "listBySession");
    const { manager } = createManager({
      compressionThreshold: 0.5,
      memory,
      messageManager,
      pruneMinimumTokens: 1,
      pruneProtectTokens: 0,
    });

    const prepared = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });

    expect(prepared.compaction?.status).toBe("pruned");
    expect(listBySession).toHaveBeenCalledTimes(1);
  });

  it("skips memory for subagent context and degrades to empty memory on load failure", async () => {
    const load = vi.fn().mockRejectedValue(new Error("cannot read memory"));
    const memory: MemoryReader = {
      load,
    };
    const { manager } = createManager({ memory });

    await expect(
      manager.assemble("session_1", "D:/repo"),
    ).resolves.toMatchObject({
      memory: { global: "", project: "", merged: "" },
    });

    const subagentContext = await manager.assemble(
      "session_1",
      "D:/repo",
      true,
    );
    expect(subagentContext.memory).toEqual({
      global: "",
      project: "",
      merged: "",
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("calculates context usage with the 85 percent compression threshold", () => {
    const usage = getContextUsage(85, "model-a", {
      getLimit: () => 100,
    });

    expect(usage).toEqual({
      currentTokens: 85,
      contextLimit: 100,
      modelId: "model-a",
      remainingTokens: 15,
      usageRatio: 0.85,
    });
  });

  it("uses input token budget rather than the full context window for compression decisions", () => {
    const usage = getContextUsage(
      45,
      "model-a",
      {
        getBudget(_modelId, options) {
          const usedInputTokens = options?.usedInputTokens ?? 0;
          return {
            contextWindowTokens: 100,
            inputBudgetTokens: 50,
            maxOutputTokens: 40,
            modelId: "model-a",
            remainingInputTokens: Math.max(0, 50 - usedInputTokens),
            reservedOutputTokens: 40,
            safetyMarginTokens: 10,
            usageRatio: usedInputTokens / 50,
            usedInputTokens,
          };
        },
        getLimit: () => 100,
      },
    );

    expect(usage).toMatchObject({
      contextLimit: 100,
      currentTokens: 45,
      inputBudgetTokens: 50,
      remainingTokens: 5,
      reservedOutputTokens: 40,
      safetyMarginTokens: 10,
      usageRatio: 0.9,
    });
  });

  it("uses a small remaining-input floor when deciding the compaction rung", () => {
    const usage = getContextUsage(
      96_500,
      "large-model",
      {
        getBudget(_modelId, options) {
          const usedInputTokens = options?.usedInputTokens ?? 0;
          const inputBudgetTokens = 100_000;
          return {
            contextWindowTokens: 128_000,
            inputBudgetTokens,
            maxOutputTokens: 20_000,
            modelId: "large-model",
            remainingInputTokens: inputBudgetTokens - usedInputTokens,
            reservedOutputTokens: 20_000,
            safetyMarginTokens: 8_000,
            usageRatio: usedInputTokens / inputBudgetTokens,
            usedInputTokens,
          };
        },
        getLimit: () => 128_000,
      },
    );

    expect(usage.usageRatio).toBeLessThan(0.97);
    expect(usage.remainingTokens).toBe(3_500);
    expect(
      decideCompactionRung({
        force: false,
        historyLength: 4,
        usage,
      }),
    ).toBe("prune-summary");
  });

  it("keeps compaction decisions on usage ratio when enough budget remains", () => {
    expect(
      decideCompactionRung({
        force: false,
        historyLength: 4,
        usage: {
          contextLimit: 100_000,
          currentTokens: 70_000,
          inputBudgetTokens: 100_000,
          modelId: "large-model",
          remainingTokens: 30_000,
          usageRatio: 0.7,
        },
      }),
    ).toBe("none");
    expect(
      decideCompactionRung({
        force: false,
        historyLength: 4,
        usage: {
        contextLimit: 1_000_000,
        currentTokens: 980_000,
          inputBudgetTokens: 1_000_000,
        modelId: "large-model",
        remainingTokens: 20_000,
        usageRatio: 0.98,
        },
      }),
    ).toBe("prune-summary");
  });

  it("does not expose legacy compress or prune APIs", () => {
    const { manager } = createManager();

    expect("compress" in manager).toBe(false);
    expect("prune" in manager).toBe(false);
  });

  it("publishes a compact-skipped event when prepareTurn decides no compaction is needed", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "small",
    });
    const { compactSkipped, manager } = createManager({
      messageManager,
      tokenCounter: {
        estimateTokens: (content: string) => content.length,
        getLimit: () => 10_000,
      },
    });

    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });

    expect(compactSkipped).toMatchObject([
      {
        reason: "not-needed",
        sessionId: "session_1",
      },
    ]);
  });

  it("prunes old completed tool output while protecting recent output", async () => {
    const messageManager = createMessageManagerFixture();
    const oldMessage = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "test",
    });
    await messageManager.appendPart(oldMessage.id, {
      type: "tool",
      callId: "old_call",
      tool: "read_file",
      state: { status: "completed", input: {}, output: "old-output" },
    });
    const recentMessage = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "test",
    });
    await messageManager.appendPart(recentMessage.id, {
      type: "tool",
      callId: "recent_call",
      tool: "read_file",
      state: { status: "completed", input: {}, output: "recent-output" },
    });
    const { manager, pruned } = createManager({ messageManager });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });

    expect(result.prune).toEqual({
      freedTokens: 10,
      protectedCount: 1,
      prunedCount: 1,
      totalScanned: 2,
    });

    const history = await messageManager.listBySession("session_1");
    expect(history[0]?.parts[0]?.time?.compacted).toBeDefined();
    expect(history[1]?.parts[0]?.time?.compacted).toBeUndefined();
    expect(pruned).toHaveLength(1);
  });

  it("compresses older history into a synthetic summary message", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "first long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "second long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "third long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "fourth long text",
    });
    const { compressed, manager } = createManager({ messageManager });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });

    expect(result.status).toBe("compacted");
    expect(result.compression?.summaryMessageId).toBe("message_5");
    expect(result.compression?.savedTokens).toBeGreaterThan(0);
    const history = await messageManager.listBySession("session_1");
    const compactedAt = history[0]?.parts[0]?.time?.compacted;
    expect(compactedAt).toBeDefined();
    expect(history[1]?.parts[0]?.time?.compacted).toBe(compactedAt);
    expect(history[2]?.parts[0]?.time?.compacted).toBe(compactedAt);
    expect(history[3]?.parts[0]?.time?.compacted).toBeUndefined();
    expect(history.at(-1)).toMatchObject({
      info: { id: "message_5", role: "assistant" },
      parts: [
        {
          metadata: { kind: "context-summary" },
          synthetic: true,
          text: "<state_snapshot>short</state_snapshot>",
          type: "text",
        },
      ],
    });
    await expect(
      manager.assemble("session_1", "D:/repo"),
    ).resolves.toMatchObject({
      hasSummary: true,
      history: [{ info: { id: "message_5" } }, { info: { id: "message_4" } }],
    });
    expect(compressed).toHaveLength(1);
  });

  it("compacts by pruning only when pruned context fits the model window", async () => {
    const messageManager = createMessageManagerFixture();
    const memory: MemoryReader = {
      load: vi.fn().mockResolvedValue({ global: "", project: "", merged: "" }),
    };
    const oldMessage = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "test",
    });
    await messageManager.appendPart(oldMessage.id, {
      type: "tool",
      callId: "old_call",
      tool: "read",
      state: { status: "completed", input: {}, output: "x".repeat(80) },
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "small",
    });
    const { manager } = createManager({
      compressionThreshold: 0.5,
      memory,
      messageManager,
      pruneMinimumTokens: 1,
      pruneProtectTokens: 0,
    });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      modelId: "model-a",
    });

    expect(result.status).toBe("pruned");
    expect(result.prune).toMatchObject({ prunedCount: 1 });
    expect(result.usageAfter.currentTokens).toBeLessThan(
      result.usageBefore.currentTokens,
    );
    const context = await manager.assemble("session_1", "D:/repo");
    expect(context.history).toHaveLength(1);
    expect(context.history[0]?.info.role).toBe("user");
  });

  it("keeps compact prune-only path to one history read", async () => {
    const messageManager = createMessageManagerFixture();
    const memory: MemoryReader = {
      load: vi.fn().mockResolvedValue({ global: "", project: "", merged: "" }),
    };
    await addCompletedToolMessage(messageManager, {
      sessionId: "session_1",
      output: "x".repeat(80),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "small",
    });
    const listBySession = vi.spyOn(messageManager, "listBySession");
    const { manager } = createManager({
      compressionThreshold: 0.5,
      memory,
      messageManager,
      pruneMinimumTokens: 1,
      pruneProtectTokens: 0,
    });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      modelId: "model-a",
    });

    expect(result.status).toBe("pruned");
    expect(listBySession).toHaveBeenCalledTimes(1);
  });

  it("ignores retained usage metadata when compact resolves through prune only", async () => {
    const messageManager = createMessageManagerFixture();
    const memory: MemoryReader = {
      load: vi.fn().mockResolvedValue({ global: "", project: "", merged: "" }),
    };
    const oldMessage = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "test",
    });
    await messageManager.appendPart(oldMessage.id, {
      type: "tool",
      callId: "old_call",
      tool: "read",
      state: { status: "completed", input: {}, output: "x".repeat(80) },
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "small",
      metadata: {
        keep: true,
        tokenUsage: {
          completionTokens: 0,
          promptTokens: 1_000,
          totalTokens: 1_000,
        },
      },
    });
    const generateSummary = vi.fn<ContextLLMClient["generateSummary"]>();
    const { manager } = createManager({
      compressionThreshold: 0.5,
      llmClient: { generateSummary },
      memory,
      messageManager,
      pruneMinimumTokens: 1,
      pruneProtectTokens: 0,
    });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      modelId: "model-a",
    });

    expect(result.status).toBe("pruned");
    expect(generateSummary).not.toHaveBeenCalled();
    expect(result.usageAfter.currentTokens).toBeLessThan(100);
    const history = await messageManager.listBySession("session_1");
    expect(history[1]?.parts[0]?.metadata).toEqual({
      keep: true,
      tokenUsage: {
        completionTokens: 0,
        promptTokens: 1_000,
        totalTokens: 1_000,
      },
    });
  });

  it("compacts by summarizing older history and re-injecting the summary into assembled context", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "first long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "second long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "third long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "fourth long text",
    });
    const { manager } = createManager({ messageManager });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });

    expect(result.status).toBe("compacted");
    expect(result.compression?.summaryMessageId).toBe("message_5");
    const context = await manager.assemble("session_1", "D:/repo");
    expect(context.hasSummary).toBe(true);
    expect(context.history).toMatchObject([
      {
        info: { id: "message_5", role: "assistant" },
        parts: [{ text: "<state_snapshot>short</state_snapshot>" }],
      },
      { info: { id: "message_4", role: "assistant" } },
    ]);
  });

  it("summarizes the active history after same-pass pruning", async () => {
    const messageManager = createMessageManagerFixture();
    const memory: MemoryReader = {
      load: vi.fn().mockResolvedValue({ global: "", project: "", merged: "" }),
    };
    const oldMessage = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "test",
    });
    await messageManager.appendPart(oldMessage.id, {
      type: "tool",
      callId: "old_call",
      tool: "read_file",
      state: {
        status: "completed",
        input: { path: "old-pruned.txt" },
        output: "x".repeat(80),
      },
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "first long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "second long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "third long text",
    });
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValue("## Goal\nshort");
    const { manager } = createManager({
      llmClient: { generateSummary },
      memory,
      messageManager,
      pruneMinimumTokens: 1,
      pruneProtectTokens: 0,
    });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });

    expect(result.status).toBe("compacted");
    const summaryInput = generateSummary.mock.calls[0][0];
    expect(
      summaryInput.history.some((message) => message.info.id === oldMessage.id),
    ).toBe(false);
    const summaryPart = (await messageManager.listBySession("session_1")).at(-1)
      ?.parts[0];
    const summary = summaryPart?.type === "text" ? summaryPart.text : "";
    expect(summary).not.toContain("old-pruned.txt");
    expect(summary).not.toContain("<read-files>");
  });

  it("retains token usage metadata after compaction because estimation no longer consumes it", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "first long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "second long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "third long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "fourth long text",
      metadata: {
        keep: true,
        tokenUsage: {
          promptTokens: 90_000,
          completionTokens: 10_000,
          totalTokens: 100_000,
        },
      },
    });
    const { manager } = createManager({
      llmClient: {
        generateSummary: vi.fn().mockResolvedValue("## Goal\nshort"),
      },
      messageManager,
    });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });

    expect(result.status).toBe("compacted");
    const activeHistory = (await manager.assemble("session_1", "D:/repo"))
      .history;
    const retained = activeHistory.find(
      (message) => message.info.id === "message_4",
    );
    expect(retained?.parts[0]?.metadata).toEqual({
      keep: true,
      tokenUsage: {
        promptTokens: 90_000,
        completionTokens: 10_000,
        totalTokens: 100_000,
      },
    });
    expect(result.usageAfter.currentTokens).toBeLessThan(
      result.usageBefore.currentTokens,
    );
  });

  it("does not commit a summary when projected usage is not lower than current usage", async () => {
    const messageManager = createMessageManagerFixture();
    for (const [index, role] of [
      "user",
      "assistant",
      "user",
      "assistant",
    ].entries()) {
      await addTextMessage(messageManager, {
        sessionId: "session_1",
        role: role as "user" | "assistant",
        text: `${String(index)} ${"x".repeat(80)}`,
        metadata:
          index === 3
            ? {
                tokenUsage: {
                  promptTokens: 1,
                  completionTokens: 1,
                  totalTokens: 2,
                },
              }
            : undefined,
      });
    }
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockImplementation((input) =>
        Promise.resolve(
          "s".repeat(Math.max(1, serializeHistory(input.history).length - 1)),
        ),
      );
    const { manager } = createManager({
      llmClient: { generateSummary },
      messageManager,
    });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });

    expect(result.status).toBe("inflated");
    expect(result.usageAfter.currentTokens).toBe(
      result.usageBefore.currentTokens,
    );
    expect(await summaryMessageCount(messageManager, "session_1")).toBe(0);
  });

  it("returns pruned when a projected summary would be worse than prune-only context", async () => {
    const messageManager = createMessageManagerFixture();
    await addCompletedToolMessage(messageManager, {
      sessionId: "session_1",
      output: "tool output ".repeat(20),
    });
    for (const [index, role] of [
      "user",
      "assistant",
      "user",
      "assistant",
    ].entries()) {
      await addTextMessage(messageManager, {
        sessionId: "session_1",
        role: role as "user" | "assistant",
        text: `${String(index)} ${"x".repeat(80)}`,
      });
    }
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockImplementation((input) =>
        Promise.resolve(
          "s".repeat(Math.max(1, serializeHistory(input.history).length - 1)),
        ),
      );
    const { manager } = createManager({
      llmClient: { generateSummary },
      messageManager,
      pruneMinimumTokens: 1,
      pruneProtectTokens: 0,
    });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });

    expect(result.status).toBe("pruned");
    expect(result.usageAfter.currentTokens).toBeLessThan(
      result.usageBefore.currentTokens,
    );
    expect(result.prune?.prunedCount).toBe(1);
    expect(await summaryMessageCount(messageManager, "session_1")).toBe(0);
  });

  it("passes the structured summarization system prompt to the summary client", async () => {
    const messageManager = createMessageManagerFixture();
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValue("## Goal\nshort");
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "first long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "second long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "third long text",
    });
    const { manager } = createManager({
      llmClient: { generateSummary },
      messageManager,
    });

    await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });

    expect(generateSummary).toHaveBeenCalledTimes(1);
    const summaryInput = generateSummary.mock.calls[0][0];
    expect(summaryInput.prompt).toContain("## Goal");
    expect(summaryInput.systemPrompt).toContain(
      "context summarization assistant",
    );
  });

  it("retries with an aggressive prompt when the first summary is inflated", async () => {
    const messageManager = createMessageManagerFixture();
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValueOnce("x".repeat(200))
      .mockResolvedValueOnce("short");
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "small one",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "small two",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "small three",
    });
    const { manager } = createManager({
      llmClient: { generateSummary },
      messageManager,
    });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });

    expect(result.status).toBe("compacted");
    expect(result.compression?.status).toBe("compressed");
    expect(generateSummary).toHaveBeenCalledTimes(2);
    expect(generateSummary.mock.calls[1][0].prompt).toContain("CRITICAL");
  });

  it("does not summarize same-pass pruned file paths in compress summaries", async () => {
    const messageManager = createMessageManagerFixture();
    const assistant = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "test",
    });
    await messageManager.appendPart(assistant.id, {
      type: "tool",
      callId: "call_read",
      tool: "read_file",
      state: {
        status: "completed",
        input: { path: "src/a.ts" },
        output: "a".repeat(200),
      },
    });
    await messageManager.appendPart(assistant.id, {
      type: "tool",
      callId: "call_edit",
      tool: "edit_file",
      state: {
        status: "completed",
        input: { file_path: "src/b.ts" },
        output: "b".repeat(200),
      },
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "middle long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "recent long text",
    });
    const { manager } = createManager({
      llmClient: {
        generateSummary: vi.fn().mockResolvedValue("## Goal\nshort"),
      },
      messageManager,
    });

    await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });
    const history = await messageManager.listBySession("session_1");
    const summaryPart = history
      .flatMap((message) => message.parts)
      .find(
        (part) =>
          part.type === "text" && part.metadata?.kind === "context-summary",
      );
    const summaryText = summaryPart?.type === "text" ? summaryPart.text : "";

    expect(summaryText).not.toContain("src/a.ts");
    expect(summaryText).toContain(
      "<modified-files>\n- src/b.ts\n</modified-files>",
    );
  });

  it("does not summarize compacted parts or include their file operations again", async () => {
    const messageManager = createMessageManagerFixture();
    const oldAssistant = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "test",
    });
    const oldPart = await messageManager.appendPart(oldAssistant.id, {
      type: "tool",
      callId: "call_old",
      tool: "read_file",
      state: {
        status: "completed",
        input: { path: "old-compacted.txt" },
        output: "old".repeat(100),
      },
    });
    await messageManager.updatePart(oldPart.id, {
      time: { compacted: 123 },
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "first active long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "second active long text",
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "third active long text",
    });
    const { manager } = createManager({
      llmClient: {
        generateSummary: vi.fn().mockResolvedValue("## Goal\nshort"),
      },
      messageManager,
    });

    await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });
    const history = await messageManager.listBySession("session_1");
    const summaryPart = history
      .flatMap((message) => message.parts)
      .find(
        (part) =>
          part.type === "text" && part.metadata?.kind === "context-summary",
      );
    const summaryText = summaryPart?.type === "text" ? summaryPart.text : "";

    expect(summaryText).not.toContain("old-compacted.txt");
  });

  it("skips compression below threshold unless forced", async () => {
    const messageManager = createMessageManagerFixture();
    const generateSummary = vi
      .fn()
      .mockResolvedValue("<state_snapshot>short</state_snapshot>");
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "small",
    });
    const { manager } = createManager({
      llmClient: { generateSummary },
      messageManager,
    });

    await expect(
      manager.compact("session_1", {
        directory: "D:/repo",
        modelId: "model-a",
      }),
    ).resolves.toMatchObject({
      status: "not-needed",
    });
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it("does not create a summary when history is too short, generation fails, or summary inflates", async () => {
    const shortHistoryManager = createMessageManagerFixture();
    await addTextMessage(shortHistoryManager, {
      sessionId: "session_short",
      role: "user",
      text: "one",
    });
    const short = createManager({ messageManager: shortHistoryManager });
    await expect(
      short.manager.compact("session_short", {
        directory: "D:/repo",
        force: true,
        modelId: "model-a",
      }),
    ).resolves.toMatchObject({
      compression: { status: "skipped" },
      status: "not-needed",
    });

    const failingMessageManager = createMessageManagerFixture();
    await addTextMessage(failingMessageManager, {
      sessionId: "session_fail",
      role: "user",
      text: "first long text",
    });
    await addTextMessage(failingMessageManager, {
      sessionId: "session_fail",
      role: "assistant",
      text: "second long text",
    });
    await addTextMessage(failingMessageManager, {
      sessionId: "session_fail",
      role: "user",
      text: "third long text",
    });
    const failing = createManager({
      llmClient: {
        generateSummary: vi.fn().mockRejectedValue(new Error("llm failed")),
      },
      messageManager: failingMessageManager,
    });
    await expect(
      failing.manager.compact("session_fail", {
        directory: "D:/repo",
        force: true,
        modelId: "model-a",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: "llm failed",
    });
    await expect(
      failingMessageManager.listBySession("session_fail"),
    ).resolves.toHaveLength(3);

    const inflatedMessageManager = createMessageManagerFixture();
    await addTextMessage(inflatedMessageManager, {
      sessionId: "session_inflated",
      role: "user",
      text: "small one",
    });
    await addTextMessage(inflatedMessageManager, {
      sessionId: "session_inflated",
      role: "assistant",
      text: "small two",
    });
    await addTextMessage(inflatedMessageManager, {
      sessionId: "session_inflated",
      role: "user",
      text: "small three",
    });
    const inflated = createManager({
      llmClient: {
        generateSummary: vi.fn().mockResolvedValue("x".repeat(200)),
      },
      messageManager: inflatedMessageManager,
    });
    await expect(
      inflated.manager.compact("session_inflated", {
        directory: "D:/repo",
        force: true,
        modelId: "model-a",
      }),
    ).resolves.toMatchObject({ status: "inflated" });
    expect(inflated.compactSkipped).toMatchObject([
      {
        reason: "inflated",
        sessionId: "session_inflated",
      },
    ]);
    await expect(
      inflatedMessageManager.listBySession("session_inflated"),
    ).resolves.toHaveLength(3);
  });

  it("skips prune when candidate output is below the minimum freed-token threshold", async () => {
    const messageManager = createMessageManagerFixture();
    const oldMessage = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "test",
    });
    await messageManager.appendPart(oldMessage.id, {
      type: "tool",
      callId: "old_call",
      tool: "read_file",
      state: { status: "completed", input: {}, output: "old-output" },
    });
    const recentMessage = await messageManager.createMessage({
      sessionId: "session_1",
      role: "assistant",
      agent: "test",
    });
    await messageManager.appendPart(recentMessage.id, {
      type: "tool",
      callId: "recent_call",
      tool: "read_file",
      state: { status: "completed", input: {}, output: "recent-output" },
    });
    const { manager } = createManager({
      messageManager,
      pruneMinimumTokens: 50,
    });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });

    expect(result.prune).toEqual({
      freedTokens: 0,
      protectedCount: 1,
      prunedCount: 0,
      totalScanned: 2,
    });
    const history = await messageManager.listBySession("session_1");
    expect(history[0]?.parts[0]?.time?.compacted).toBeUndefined();
  });
});
