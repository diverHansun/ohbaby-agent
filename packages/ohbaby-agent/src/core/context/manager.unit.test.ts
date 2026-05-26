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
import { estimateContextTokens } from "./token-estimation.js";

interface ContextFixture {
  readonly compactSkipped: readonly unknown[];
  readonly compressed: readonly unknown[];
  readonly manager: ReturnType<typeof createContextManager>;
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
): MessageWithParts {
  const id = `${role}_${text}`;
  return {
    info: {
      agent: "test",
      id,
      role,
      sessionId: "session_1",
      time: { created: 1 },
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
    readonly pruneProtectTokens?: number;
    readonly pruneMinimumTokens?: number;
  } = {},
): ContextFixture {
  const bus = createBus();
  const compactSkipped: unknown[] = [];
  const compressed: unknown[] = [];
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

  return {
    compactSkipped,
    compressed,
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
  });
}

describe("ContextManager", () => {
  it("estimates context tokens from serialized history when no provider anchor exists", () => {
    const history = [
      messageWithText("user", "one"),
      messageWithText("assistant", "two"),
    ];

    expect(
      estimateContextTokens(history, {
        estimateTokens: (content: string) => content.length,
      }),
    ).toEqual({
      anchorIndex: -1,
      anchorTokens: 0,
      tailTokens: serializeHistory(history).length,
      tokens: serializeHistory(history).length,
    });
  });

  it("estimates context tokens from the latest provider usage anchor plus tail", () => {
    const history = [
      messageWithText("user", "old user"),
      messageWithText("assistant", "old assistant", {
        tokenUsage: {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
        },
      }),
      messageWithText("user", "tail"),
    ];

    expect(
      estimateContextTokens(history, {
        estimateTokens: (content: string) => content.length,
      }),
    ).toEqual({
      anchorIndex: 1,
      anchorTokens: 120,
      tailTokens: "user: tail".length,
      tokens: 120 + "user: tail".length,
    });
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

  it("assembles system prompt, memory, and message history", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "hello",
    });
    const { manager } = createManager({ messageManager });

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

    const { manager } = createManager({ messageManager });
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
              arguments: "{\"path\":\"README.md\"}",
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_read", content: "content" },
    ]);
  });

  it("prepareTurn returns provider-ready messages without mutating below threshold", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "hello",
    });
    const { manager } = createManager({ messageManager });

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
    expect(prepared.usage.shouldCompress).toBe(false);
    expect(prepared.hasSummary).toBe(false);
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
      llmClient: { generateSummary: vi.fn().mockResolvedValue("## Goal\nshort") },
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
    const usage = getContextUsage({ estimatedTokens: 85 }, "model-a", {
      getLimit: () => 100,
    });

    expect(usage).toEqual({
      currentTokens: 85,
      contextLimit: 100,
      modelId: "model-a",
      remainingTokens: 15,
      shouldCompress: true,
      usageRatio: 0.85,
    });
  });

  it("uses input token budget rather than the full context window for compression decisions", () => {
    const usage = getContextUsage(
      { estimatedTokens: 45 },
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
      0.85,
    );

    expect(usage).toMatchObject({
      contextLimit: 100,
      currentTokens: 45,
      inputBudgetTokens: 50,
      remainingTokens: 5,
      reservedOutputTokens: 40,
      safetyMarginTokens: 10,
      shouldCompress: true,
      usageRatio: 0.9,
    });
  });

  it("uses absolute remaining-token reserve when model budget is available", () => {
    const usage = getContextUsage(
      { estimatedTokens: 980_000 },
      "large-model",
      {
        getBudget(_modelId, options) {
          const usedInputTokens = options?.usedInputTokens ?? 0;
          const inputBudgetTokens = 1_000_000;
          return {
            contextWindowTokens: 1_048_576,
            inputBudgetTokens,
            maxOutputTokens: 32_000,
            modelId: "large-model",
            remainingInputTokens: inputBudgetTokens - usedInputTokens,
            reservedOutputTokens: 32_000,
            safetyMarginTokens: 16_384,
            usageRatio: usedInputTokens / inputBudgetTokens,
            usedInputTokens,
          };
        },
        getLimit: () => 1_048_576,
      },
      0.85,
    );

    expect(usage.usageRatio).toBeGreaterThan(0.85);
    expect(usage.remainingTokens).toBe(20_000);
    expect(usage.shouldCompress).toBe(false);
  });

  it("uses the precomputed context usage decision in shouldCompress", () => {
    const { manager } = createManager();

    expect(
      manager.shouldCompress({
        contextLimit: 1_000_000,
        currentTokens: 980_000,
        modelId: "large-model",
        remainingTokens: 20_000,
        shouldCompress: false,
        usageRatio: 0.98,
      }),
    ).toBe(false);
  });

  it("publishes a compact-skipped event when prepareTurn decides no compaction is needed", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "small",
    });
    const { compactSkipped, manager } = createManager({ messageManager });

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

    await expect(manager.prune("session_1")).resolves.toEqual({
      freedTokens: 10,
      protectedCount: 1,
      prunedCount: 1,
      totalScanned: 2,
    });

    const history = await messageManager.listBySession("session_1");
    expect(history[0]?.parts[0]?.time?.compacted).toBe(1_000);
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

    const result = await manager.compress("session_1", true);

    expect(result.status).toBe("compressed");
    expect(result.summaryMessageId).toBe("message_5");
    expect(result.savedTokens).toBeGreaterThan(0);
    const history = await messageManager.listBySession("session_1");
    expect(history[0]?.parts[0]?.time?.compacted).toBe(1_000);
    expect(history[1]?.parts[0]?.time?.compacted).toBe(1_000);
    expect(history[2]?.parts[0]?.time?.compacted).toBe(1_000);
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

    await manager.compress("session_1", true);

    expect(generateSummary).toHaveBeenCalledTimes(1);
    const summaryInput = generateSummary.mock.calls[0][0];
    expect(summaryInput.prompt).toContain("## Goal");
    expect(summaryInput.systemPrompt).toContain(
      "context summarization assistant",
    );
  });

  it("appends compressed read and modified file paths to the summary", async () => {
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
      llmClient: { generateSummary: vi.fn().mockResolvedValue("## Goal\nshort") },
      messageManager,
    });

    await manager.compress("session_1", true);
    const history = await messageManager.listBySession("session_1");
    const summaryPart = history
      .flatMap((message) => message.parts)
      .find(
        (part) =>
          part.type === "text" && part.metadata?.kind === "context-summary",
      );
    const summaryText = summaryPart?.type === "text" ? summaryPart.text : "";

    expect(summaryText).toContain("<read-files>\n- src/a.ts\n</read-files>");
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
      llmClient: { generateSummary: vi.fn().mockResolvedValue("## Goal\nshort") },
      messageManager,
    });

    await manager.compress("session_1", true);
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

    await expect(manager.compress("session_1", false)).resolves.toEqual({
      status: "skipped",
      originalTokens: 11,
      newTokens: 11,
      savedTokens: 0,
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
      short.manager.compress("session_short", true),
    ).resolves.toMatchObject({
      status: "skipped",
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
      failing.manager.compress("session_fail", true),
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
      inflated.manager.compress("session_inflated", true),
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

    await expect(manager.prune("session_1")).resolves.toEqual({
      freedTokens: 0,
      protectedCount: 1,
      prunedCount: 0,
      totalScanned: 2,
    });
    const history = await messageManager.listBySession("session_1");
    expect(history[0]?.parts[0]?.time?.compacted).toBeUndefined();
  });
});
