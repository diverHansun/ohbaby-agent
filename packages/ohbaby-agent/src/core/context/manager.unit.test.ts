import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../message/index.js";
import type { MessageIdGenerator, MessageManager } from "../message/index.js";
import {
  ContextEvent,
  createContextManager,
  getContextUsage,
} from "./index.js";
import type {
  ContextLLMClient,
  MemoryReader,
  SystemPromptProvider,
  TokenCounter,
} from "./types.js";

interface ContextFixture {
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
  bus.subscribe(ContextEvent.Pruned, (payload) => {
    pruned.push(payload);
  });

  return { compressed, manager, memory, pruned, systemPromptProvider };
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
