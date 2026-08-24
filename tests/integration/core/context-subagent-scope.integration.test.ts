import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import {
  createContextManager,
  type ContextLLMClient,
  type MemoryReader,
  type SystemPromptProvider,
  type TokenCounter,
} from "../../../packages/ohbaby-agent/src/core/context/index.js";
import { estimateWireHeuristic } from "../../../packages/ohbaby-agent/src/core/context/token-estimation.js";
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
    expect(JSON.stringify(preparedB.request.messages)).toContain(
      "scope-b-sentinel",
    );
    expect(JSON.stringify(preparedB.request.messages)).not.toContain(
      "scope a short",
    );
    expect(generateSummary).toHaveBeenCalledOnce();
    expect(generateSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        contextScopeId: "scope_a",
        sessionId: "child_1",
      }),
    );
    expect(memory.load).not.toHaveBeenCalled();
  });

  it("compacts primary and child scopes independently with request-shaped usage", async () => {
    const bus = createBus();
    const messageManager = createMessageManager({
      bus,
      idGenerator: createIds(),
      store: createInMemoryMessageStore(),
    });
    const appendHistory = async (input: {
      readonly agent: "build" | "explore";
      readonly contextScopeId?: string;
      readonly sessionId: string;
      readonly sentinel: string;
    }): Promise<void> => {
      for (const [index, role] of [
        "user",
        "assistant",
        "user",
        "assistant",
      ].entries()) {
        const message = await messageManager.createMessage({
          agent: input.agent,
          ...(input.contextScopeId === undefined
            ? {}
            : { contextScopeId: input.contextScopeId }),
          role: role as "assistant" | "user",
          sessionId: input.sessionId,
        });
        await messageManager.appendPart(message.id, {
          text: `${input.sentinel}-${String(index)} ${"large ".repeat(1_000)}`,
          type: "text",
        });
      }
    };
    await appendHistory({
      agent: "build",
      sentinel: "primary",
      sessionId: "parent_1",
    });
    await appendHistory({
      agent: "explore",
      contextScopeId: "scope_a",
      sentinel: "child",
      sessionId: "child_1",
    });

    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockImplementation((input) =>
        Promise.resolve(
          `<state_snapshot>${input.contextScopeId ?? "primary"} short</state_snapshot>`,
        ),
      );
    const tokenCounter = {
      estimateTokens: (content: string): number => content.length,
      getLimit: (): number => 20_000,
    } satisfies TokenCounter;
    const manager = createContextManager({
      bus,
      llmClient: { generateSummary },
      memory: {
        load: vi.fn().mockResolvedValue({
          global: "",
          merged: "",
          project: "",
        }),
      },
      messageManager,
      systemPromptProvider: {
        build: vi.fn().mockResolvedValue("stable"),
      },
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

    const primary = await manager.prepareTurn({
      agentName: "build",
      directory: "/repo",
      isSubagent: false,
      modelId: "fake-model",
      sessionId: "parent_1",
      toolNames: ["read_file"],
      tools,
    });
    const child = await manager.prepareTurn({
      agentName: "explore",
      contextScopeId: "scope_a",
      directory: "/repo",
      isSubagent: true,
      modelId: "fake-model",
      sessionId: "child_1",
      toolNames: ["read_file"],
      tools,
    });

    expect(primary.compaction?.status).toBe("compacted");
    expect(child.compaction?.status).toBe("compacted");
    expect(primary.request.tools).toEqual(tools);
    expect(child.request.tools).toEqual(tools);
    expect(primary.usage.currentTokens).toBe(
      estimateWireHeuristic(
        primary.request.messages,
        tokenCounter,
        primary.request.tools,
      ),
    );
    expect(child.usage.currentTokens).toBe(
      estimateWireHeuristic(
        child.request.messages,
        tokenCounter,
        child.request.tools,
      ),
    );
    expect(JSON.stringify(primary.request.messages)).toContain("primary short");
    expect(JSON.stringify(primary.request.messages)).not.toContain(
      "scope_a short",
    );
    expect(JSON.stringify(child.request.messages)).toContain("scope_a short");
    expect(JSON.stringify(child.request.messages)).not.toContain(
      "primary short",
    );
    expect(generateSummary.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ sessionId: "parent_1" }),
      expect.objectContaining({
        contextScopeId: "scope_a",
        sessionId: "child_1",
      }),
    ]);
  });
});
