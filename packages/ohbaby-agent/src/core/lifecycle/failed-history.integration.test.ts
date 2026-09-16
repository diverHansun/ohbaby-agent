import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import { Lifecycle } from "./lifecycle.js";
import type { LifecycleEvent, LifecycleResult } from "./types.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  readTokenUsageMetadata,
} from "../message/index.js";
import type { ContextManager } from "../context/index.js";
import type { LLMClientInstance } from "../llm-client/types.js";
import type { ToolSchedulerInstance } from "../tool-scheduler/index.js";
import type { InterfaceProviderStreamEvent } from "../../services/interface-providers/types.js";
import { serializeHistoryMessages } from "../context/serializer.js";
import { serializeHistory } from "../context/serialization.js";
import { ensureInterruptionFact } from "../message/interruption.js";

function fixture(
  events: InterfaceProviderStreamEvent[],
  after?: () => void,
): {
  run: (
    signal?: AbortSignal,
  ) => Promise<{ result: LifecycleResult; events: LifecycleEvent[] }>;
  manager: ReturnType<typeof createMessageManager>;
  execute: ReturnType<typeof vi.fn<ToolSchedulerInstance["executeBatch"]>>;
} {
  const manager = createMessageManager({
    bus: createBus(),
    store: createInMemoryMessageStore(),
  });
  const client: LLMClientInstance = {
    config: {
      provider: "test",
      model: "test",
      interfaceProvider: "openai-compatible",
      baseUrl: "https://test.invalid",
      maxTokens: 100,
      modelProfiles: [
        {
          model: "test",
          contextWindowTokens: 10000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
    },
    provider: {
      id: "test",
      kind: "openai-compatible",
      client: {},
      isAbortError: () => false,
      streamResponse: () =>
        Promise.resolve(
          (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            for (const event of events) yield await Promise.resolve(event);
            after?.();
          })(),
        ),
    },
  };
  const context: ContextManager = {
    assemble: vi.fn(),
    compact: vi.fn(),
    disposeScope: vi.fn(),
    disposeSession: vi.fn(),
    getUsage: vi.fn(),
    resetTurnCompactionCount: vi.fn(),
    updateCalibrationFactor: vi.fn(),
    createRunPromptSnapshot: vi.fn().mockResolvedValue({
      memory: { global: "", project: "", merged: "" },
      systemPrompt: "",
    }),
    prepareTurn: vi.fn().mockResolvedValue({
      assembledAt: 1,
      hasSummary: false,
      request: {
        messages: [{ role: "user", content: "test" }],
        tools: undefined,
      },
      sentHeuristic: 10,
      usage: {
        currentTokens: 10,
        contextLimit: 10000,
        remainingTokens: 9990,
        usageRatio: 0.001,
        modelId: "test",
      },
    }),
  };
  const execute = vi
    .fn<ToolSchedulerInstance["executeBatch"]>()
    .mockResolvedValue([]);
  const loop = new Lifecycle({
    contextManager: context,
    llmClient: client,
    messageManager: manager,
    toolScheduler: {
      executeBatch: execute,
    } as unknown as ToolSchedulerInstance,
  });
  return {
    manager,
    execute,
    async run(
      signal,
    ): Promise<{ result: LifecycleResult; events: LifecycleEvent[] }> {
      const iterator = loop.run({
        sessionId: "session",
        contextScopeId: "child",
        modelId: "test",
        directory: "/tmp",
        signal,
      });
      const seen: LifecycleEvent[] = [];
      for (;;) {
        const item = await iterator.next();
        if (item.done) return { result: item.value, events: seen };
        seen.push(item.value);
      }
    },
  };
}
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

describe("failed model history persistence", () => {
  it.each([
    {
      finishReason: "length" as const,
      error: "MessageOutputLengthError",
      notice: "[Response incomplete: output limit reached.]",
    },
    {
      finishReason: "content_filter" as const,
      error: "MessageContentFilterError",
      notice: "[Response incomplete: content was filtered.]",
    },
  ])(
    "saves $finishReason classification and projects only visible saved text",
    async ({ finishReason, error, notice }) => {
      const f = fixture([
        { textDelta: "saved body", finishReason, tokenUsage: usage },
      ]);
      const { result } = await f.run();
      expect(result.success).toBe(false);
      const history = await f.manager.listBySession("session");
      expect(history[0].info).toMatchObject({
        role: "assistant",
        finish: "error",
        error: { name: error },
        contextScopeId: "child",
      });
      expect(serializeHistoryMessages(history)).toEqual([
        { role: "assistant", content: `${notice}\nsaved body` },
      ]);
      expect(serializeHistory(history, { includeToolContext: true })).toContain(
        `${notice}\nsaved body`,
      );
      expect(f.execute).not.toHaveBeenCalled();
    },
  );
  it.each(["length", "content_filter"] as const)(
    "saves accepted usage on a no-body %s fact",
    async (finishReason) => {
      const f = fixture([{ finishReason, tokenUsage: usage }]);
      await f.run();
      const history = await f.manager.listBySession("session");
      expect(history[0].parts).toHaveLength(1);
      expect(history[0].parts[0]).toMatchObject({
        type: "text",
        synthetic: true,
      });
      expect(readTokenUsageMetadata(history[0].parts[0].metadata)).toEqual(
        usage,
      );
    },
  );
  it("preserves known transport failure text", async () => {
    const f = fixture([{ textDelta: "saved fragment" }], () => {
      throw Object.assign(new Error("wire closed"), { code: "ECONNRESET" });
    });
    await f.run();
    const history = await f.manager.listBySession("session");
    expect(history[0].info).toMatchObject({
      error: { name: "MessageStreamInterruptedError" },
    });
    expect(serializeHistoryMessages(history)).toEqual([
      {
        role: "assistant",
        content:
          "[Response interrupted: the saved text below may be incomplete.]\nsaved fragment",
      },
    ]);
  });
  it("persists one retireable fact for EOF without visible text", async () => {
    const f = fixture([]);
    await f.run();
    const history = await f.manager.listBySession("session");
    expect(history[0].info).toMatchObject({
      error: { name: "MessageStreamInterruptedError" },
    });
    expect(history[0].parts).toHaveLength(1);
    expect(history[0].parts[0]).toMatchObject({
      type: "text",
      synthetic: true,
      metadata: { kind: "lifecycle-interruption" },
      contextScopeId: "child",
    });
    expect(serializeHistoryMessages(history)).toEqual([
      {
        role: "assistant",
        content:
          "[Response interrupted: the saved text below may be incomplete.]",
      },
    ]);
    await f.manager.updatePart(history[0].parts[0].id, {
      time: { compacted: 2 },
    });
    const assistant = history[0].info;
    if (assistant.role !== "assistant") throw new Error("Expected assistant");
    await ensureInterruptionFact(
      f.manager,
      assistant,
      "MessageStreamInterruptedError",
    );
    const retired = await f.manager.listBySession("session");
    expect(retired[0].parts).toHaveLength(1);
    expect(serializeHistoryMessages(retired)).toEqual([]);
  });
  it.each(["private unfinished body", ""])(
    "keeps cancellation body only in storage: %j",
    async (body) => {
      const controller = new AbortController();
      const f = fixture(body ? [{ textDelta: body }] : [], () => {
        controller.abort();
      });
      const { result } = await f.run(controller.signal);
      expect(result.terminalReason).toBe("cancelled");
      const history = await f.manager.listBySession("session");
      expect(history[0].info).toMatchObject({
        error: { name: "MessageAbortedError" },
      });
      const facts = history[0].parts.filter(
        (p) => p.type === "text" && p.synthetic,
      );
      expect(facts).toHaveLength(1);
      expect(
        history[0].parts.filter((p) => p.type === "text" && !p.synthetic),
      ).toHaveLength(body ? 1 : 0);
      expect(serializeHistoryMessages(history)).toEqual([
        { role: "assistant", content: "[Response cancelled by the user.]" },
      ]);
      expect(serializeHistory(history, { includeToolContext: true })).toBe(
        "assistant: [Response cancelled by the user.]",
      );
    },
  );
  it("does not replay text after an unknown or protocol failure", async () => {
    const f = fixture([{ textDelta: "unsafe partial" }], () => {
      throw new Error("native projection invalid");
    });
    await f.run();
    const history = await f.manager.listBySession("session");
    expect(history[0].info).toMatchObject({ finish: "error" });
    expect(serializeHistoryMessages(history)).toEqual([]);
    expect(
      serializeHistory(history, { includeToolContext: true }),
    ).not.toContain("unsafe partial");
  });
  it("keeps accepted tool results when the user cancels during tool execution", async () => {
    const controller = new AbortController();
    const f = fixture([
      {
        toolCallDeltas: [
          { index: 0, id: "read-1", name: "read", argumentsDelta: "{}" },
        ],
        finishReason: "tool_calls",
      },
    ]);
    f.execute.mockImplementation(() => {
      controller.abort();
      return Promise.resolve([
        { callId: "read-1", status: "success", output: "saved tool fact" },
      ]);
    });
    const { result } = await f.run(controller.signal);
    expect(result.terminalReason).toBe("cancelled");
    const history = await f.manager.listBySession("session");
    expect(history[0].info).toMatchObject({ finish: "tool_calls" });
    expect(history[0].info).not.toHaveProperty("error");
    expect(serializeHistoryMessages(history)).toEqual([
      {
        role: "assistant",
        content: null,
        toolCalls: [{ callId: "read-1", name: "read", argumentsJson: "{}" }],
      },
      { role: "tool", callId: "read-1", content: "saved tool fact" },
      { role: "assistant", content: "[Response cancelled by the user.]" },
    ]);
  });
});
