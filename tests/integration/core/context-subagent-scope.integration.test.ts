import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import {
  createContextManager,
  type ContextLLMClient,
  type MemoryReader,
  type SystemPromptProvider,
  type TokenCounter,
} from "../../../packages/ohbaby-agent/src/core/context/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  type MessageIdGenerator,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";

function createIds(): MessageIdGenerator {
  let messageId = 0;
  let partId = 0;
  return {
    messageId: () => `message_${String(++messageId)}`,
    partId: () => `part_${String(++partId)}`,
  };
}

describe("subagent scoped context integration", () => {
  it("automatically compacts only the over-limit scope in a shared child session", async () => {
    const bus = createBus();
    const messageManager = createMessageManager({
      bus,
      idGenerator: createIds(),
      store: createInMemoryMessageStore(),
    });
    const appendScopedText = async (
      contextScopeId: string,
      role: "assistant" | "user",
      text: string,
    ): Promise<void> => {
      const message = await messageManager.createMessage({
        agent: "explore",
        contextScopeId,
        role,
        sessionId: "child_1",
      });
      await messageManager.appendPart(message.id, { text, type: "text" });
    };
    for (const [index, role] of [
      "user",
      "assistant",
      "user",
      "assistant",
    ].entries()) {
      await appendScopedText(
        "scope_a",
        role as "assistant" | "user",
        `scope-a-${String(index)} ${"large ".repeat(1_000)}`,
      );
    }
    await appendScopedText("scope_b", "user", "scope-b-sentinel");

    const memory = {
      load: vi.fn().mockResolvedValue({
        global: "must not load",
        merged: "must not load",
        project: "must not load",
      }),
    } satisfies MemoryReader;
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValue("<state_snapshot>scope a short</state_snapshot>");
    const systemPromptProvider = {
      build: vi.fn<SystemPromptProvider["build"]>().mockResolvedValue("child"),
    } satisfies SystemPromptProvider;
    const tokenCounter = {
      estimateTokens: (content: string): number => content.length,
      getLimit: (): number => 20_000,
    } satisfies TokenCounter;
    const manager = createContextManager({
      bus,
      llmClient: { generateSummary },
      memory,
      messageManager,
      systemPromptProvider,
      tokenCounter,
    });
    const tools = [
      {
        function: {
          name: "read_file",
          parameters: { type: "object" },
        },
        type: "function" as const,
      },
    ];

    const preparedA = await manager.prepareTurn({
      agentName: "explore",
      contextScopeId: "scope_a",
      directory: "/repo",
      isSubagent: true,
      modelId: "fake-model",
      sessionId: "child_1",
      toolNames: ["read_file"],
      tools,
    });
    const scopeBBefore = await messageManager.listBySession("child_1", {
      contextScopeId: "scope_b",
    });
    const preparedB = await manager.prepareTurn({
      agentName: "explore",
      contextScopeId: "scope_b",
      directory: "/repo",
      isSubagent: true,
      modelId: "fake-model",
      sessionId: "child_1",
      toolNames: ["read_file"],
      tools,
    });
    const scopeAAfter = await messageManager.listBySession("child_1", {
      contextScopeId: "scope_a",
    });
    const scopeBAfter = await messageManager.listBySession("child_1", {
      contextScopeId: "scope_b",
    });

    expect(preparedA.compaction?.status).toBe("compacted");
    expect(preparedB.compaction).toBeUndefined();
    expect(JSON.stringify(scopeAAfter)).toContain("scope a short");
    expect(scopeBAfter).toEqual(scopeBBefore);
    expect(JSON.stringify(preparedB.messages)).toContain("scope-b-sentinel");
    expect(JSON.stringify(preparedB.messages)).not.toContain("scope a short");
    expect(generateSummary).toHaveBeenCalledOnce();
    expect(memory.load).not.toHaveBeenCalled();
  });
});
