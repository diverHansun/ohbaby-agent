import {
  encodeDiagnosticEvent,
  type Logger,
} from "../../observability/logger.js";
import { COMPRESSION_PROMPT } from "./compression-prompt.js";
import { estimatePreparedRequestHeuristic } from "./token-estimation.js";
import { describe, expect, it, vi } from "vitest";
import { ProviderStreamInterruptedError } from "../llm-client/retry.js";
import type { SummaryRequestRecord } from "../llm-client/types.js";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../message/index.js";
import { createContextManager } from "./context-manager.js";
import type { ContextLLMClient, ContextManagerOptions } from "./types.js";
import { createHeuristicTokenCounter } from "../../services/llm-model/tokenCounting.js";

const fixtureInput = {
  sessionId: "s",
  directory: "/repo",
  modelId: "m",
  toolNames: [],
  tools: undefined,
  force: true,
  requestSettings: {
    model: "m",
    maxTokens: 4096,
    reasoning: {
      intent: {
        enabled: false,
        effort: "medium",
        explicit: { enabled: false, effort: false },
      },
      mode: "none",
      wire: "none",
      capabilitySource: "test",
    },
  },
} as const;

async function fixture(
  generateSummary: ContextLLMClient["generateSummary"],
  overrides: Partial<ContextManagerOptions> = {},
  historyRepeats = 2000,
): Promise<{
  manager: ReturnType<typeof createContextManager>;
  messages: ReturnType<typeof createMessageManager>;
  input: typeof fixtureInput;
}> {
  const messages = createMessageManager({
    bus: createBus(),
    store: createInMemoryMessageStore(),
  });
  for (let i = 0; i < 8; i++) {
    const message = await messages.createMessage({
      sessionId: "s",
      role: i % 2 ? "assistant" : "user",
      agent: "primary",
    });
    await messages.appendPart(message.id, {
      type: "text",
      text: `message-${String(i)} ` + "history ".repeat(historyRepeats),
    });
  }
  const manager = createContextManager({
    bus: createBus(),
    messageManager: messages,
    memory: {
      load: () => Promise.resolve({ global: "", project: "", merged: "" }),
    },
    systemPromptProvider: { build: () => Promise.resolve("NORMAL SYSTEM") },
    tokenCounter: createHeuristicTokenCounter({ defaultLimit: 128000 }),
    llmClient: { generateSummary },
    ...overrides,
  });
  return { manager, messages, input: fixtureInput };
}
describe("summary prepared request", () => {
  it("forks the complete normal request and reserves its independent output", async () => {
    const generateSummary = vi.fn(
      (input: Parameters<ContextLLMClient["generateSummary"]>[0]) =>
        Promise.resolve({
          text: "checkpoint",
          summaryMessageId: input.summaryMessageId,
          requests: [],
        }),
    );
    const { manager, input } = await fixture(generateSummary);
    const normal = await manager.prepareTurn({ ...input, force: false });
    const result = await manager.prepareTurn(input);
    expect(generateSummary).toHaveBeenCalledTimes(1);
    const summary = generateSummary.mock.calls[0][0];
    expect(summary.request.messages.slice(0, -1)).toEqual(
      normal.request.messages,
    );
    expect(summary.request.settings?.maxTokens).toBe(16384);
    expect(summary.request.settings?.reasoning).toEqual(
      normal.request.settings?.reasoning,
    );
    expect(summary.summaryMessageId).toBeTruthy();
    expect(result.compaction?.compression).toMatchObject({
      summaryMessageId: summary.summaryMessageId,
    });
  });
  it("retries a transport failure only once and leaves history active on failure", async () => {
    const generateSummary = vi.fn(async () => {
      await Promise.resolve();
      throw Object.assign(new Error("disconnected"), { code: "ECONNRESET" });
    });
    const { manager, messages, input } = await fixture(generateSummary);
    const before = await messages.listBySession("s");
    const result = await manager.prepareTurn(input);
    expect(generateSummary).toHaveBeenCalledTimes(2);
    expect(result.compaction?.status).toBe("failed");
    expect(await messages.listBySession("s")).toEqual(before);
  });
});

const successfulSummary: ContextLLMClient["generateSummary"] = (input) =>
  Promise.resolve({
    text: "checkpoint",
    summaryMessageId: input.summaryMessageId,
    requests: [],
  });

it.each([
  ["disabled", undefined, 16384],
  ["none", undefined, 16384],
  ["effort", 65536, 81920],
  ["effort", undefined, 32768],
  ["binary", undefined, 32768],
  ["service-default", undefined, 32768],
] as const)(
  "reserves %s thinking with fixed budget %s as %s",
  async (mode, budgetTokens, expected) => {
    const generateSummary = vi.fn(successfulSummary);
    const counter = createHeuristicTokenCounter({
      defaultLimit: 128000,
      defaultMaxOutputTokens: 4096,
    });
    const getBudget = vi.fn(
      (model: string, options?: Parameters<typeof counter.getBudget>[1]) =>
        counter.getBudget(model, options),
    );
    const { manager, input } = await fixture(generateSummary, {
      tokenCounter: { ...counter, getBudget },
    });
    const reasoning = {
      ...input.requestSettings.reasoning,
      mode,
      ...(budgetTokens === undefined ? {} : { budgetTokens }),
    };
    await manager.prepareTurn({
      ...input,
      requestSettings: { ...input.requestSettings, reasoning },
    });
    expect(generateSummary).toHaveBeenCalledOnce();
    expect(generateSummary.mock.calls[0][0].request.settings).toMatchObject({
      maxTokens: expected,
      reasoning,
    });
    expect(
      getBudget.mock.calls.some(
        ([, options]) => options?.requestedOutputTokens === expected,
      ),
    ).toBe(true);
  },
);

it("compacts before 90 percent when the full ordinary output no longer fits", async () => {
  const generateSummary = vi.fn(successfulSummary);
  const { manager, input } = await fixture(generateSummary);
  const result = await manager.prepareTurn({
    ...input,
    force: false,
    requestSettings: { ...input.requestSettings, maxTokens: 110000 },
  });
  expect(result.compaction?.status).toBe("compacted");
  if (!result.compaction) throw new Error("Expected compaction");
  expect(
    result.compaction.usageBefore.currentTokens /
      result.compaction.usageBefore.contextLimit,
  ).toBeLessThan(0.9);
  expect(result.compaction.usageBefore.reservedOutputTokens).toBe(110000);
  expect(generateSummary.mock.calls[0][0].request.settings?.maxTokens).toBe(
    16384,
  );
});

it("rejects a locally oversized summary without invoking the provider or changing history", async () => {
  const generateSummary = vi.fn(successfulSummary);
  const { manager, messages, input } = await fixture(generateSummary, {
    tokenCounter: createHeuristicTokenCounter({ defaultLimit: 16000 }),
  });
  const before = await messages.listBySession("s");
  const result = await manager.prepareTurn(input);
  expect(result.compaction?.status).toBe("failed");
  expect(generateSummary).not.toHaveBeenCalled();
  expect(await messages.listBySession("s")).toEqual(before);
});

it("discards partial transport output and returns both attempts owned by the committed summary", async () => {
  const records: SummaryRequestRecord[] = [];
  const generateSummary = vi.fn(
    async (input: Parameters<ContextLLMClient["generateSummary"]>[0]) => {
      await Promise.resolve();
      const record: SummaryRequestRecord = {
        requestId: `request-${String(input.attempt)}`,
        messageId: input.summaryMessageId,
        compactionId: input.compactionId,
        purpose: "context-summary",
        attempt: input.attempt,
        startedAt: 1,
        endedAt: 2,
        outcome: input.attempt === 1 ? "error" : "success",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          reasoningTokens: 10,
        },
      };
      records.push(record);
      input.onRequestRecord?.(record);
      if (input.attempt === 1)
        throw new ProviderStreamInterruptedError(
          new Error("SDK connection failure after partial text and thinking"),
          "transport",
        );
      return {
        text: "clean replacement",
        summaryMessageId: input.summaryMessageId,
        requests: [record],
      };
    },
  );
  const { manager, messages, input } = await fixture(generateSummary);
  const result = await manager.prepareTurn(input);
  expect(generateSummary).toHaveBeenCalledTimes(2);
  expect(generateSummary.mock.calls[0][0].request).toBe(
    generateSummary.mock.calls[1][0].request,
  );
  expect(result.compaction?.compression?.requests).toEqual(records);
  const summary = (await messages.listBySession("s")).find(
    (m) => m.info.id === records[0].messageId,
  );
  expect(summary?.parts).toContainEqual(
    expect.objectContaining({ type: "text", text: "clean replacement" }),
  );
  expect(summary?.info.role).toBe("assistant");
  if (summary?.info.role === "assistant")
    expect(summary.info.modelRequests).toEqual(
      records.filter((record) => record.outcome === "success"),
    );
});

it.each(["protocol", "eof", "provider_abort"] as const)(
  "does not retry a %s interruption",
  async (source) => {
    const generateSummary = vi.fn(async () => {
      await Promise.resolve();
      throw new ProviderStreamInterruptedError(
        Object.assign(new Error("failed"), { code: "ECONNRESET" }),
        source,
      );
    });
    const { manager, input } = await fixture(generateSummary);
    expect((await manager.prepareTurn(input)).compaction?.status).toBe(
      "failed",
    );
    expect(generateSummary).toHaveBeenCalledOnce();
  },
);

it.each(["force", "manual"] as const)(
  "%s cancels during network retry delay and keeps completed tool output active",
  async (entry) => {
    const controller = new AbortController();
    const diagnosticRecords: Readonly<Record<string, unknown>>[] = [];
    const logger: Logger = {
      emit(definition, input) {
        diagnosticRecords.push(
          encodeDiagnosticEvent(
            definition,
            input,
            { roots: {} },
            "2026-10-13T00:00:00Z",
          ).record,
        );
      },
    };
    const generateSummary = vi.fn(
      async (input: Parameters<ContextLLMClient["generateSummary"]>[0]) => {
        await Promise.resolve();
        input.onRequestRecord?.({
          requestId: "failed",
          messageId: input.summaryMessageId,
          compactionId: input.compactionId,
          purpose: "context-summary",
          attempt: 1,
          startedAt: 1,
          endedAt: 2,
          outcome: "error",
        });
        setTimeout(() => {
          controller.abort();
        }, 5);
        throw Object.assign(new Error("disconnected"), { code: "ECONNRESET" });
      },
    );
    const { manager, messages, input } = await fixture(generateSummary, {
      logger,
    });
    for (let i = 0; i < 3; i++) {
      const old = await messages.createMessage({
        sessionId: "s",
        role: "assistant",
        agent: "primary",
      });
      await messages.appendPart(old.id, {
        type: "tool",
        tool: "read",
        callId: `old-${String(i)}`,
        state: {
          status: "completed",
          input: { path: "file" },
          output: "ORIGINAL".repeat(12500),
        },
      });
    }
    const before = await messages.listBySession("s");
    const options = { ...input, signal: controller.signal };
    await expect(
      entry === "manual"
        ? manager.compact(input.sessionId, options)
        : manager.prepareTurn(options),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(generateSummary).toHaveBeenCalledOnce();
    expect(diagnosticRecords).toHaveLength(1);
    expect(diagnosticRecords[0]).toMatchObject({
      event: "llm.context_summary.unused",
      reason: "aborted",
      attempt: 1,
    });
    expect(diagnosticRecords[0]).not.toHaveProperty("inputTokens");
    expect(await messages.listBySession("s")).toEqual(before);
  },
);

it.each(["force", "manual"] as const)(
  "preserves full tool results and ordinary request prefix for %s summaries",
  async (entry) => {
    const generateSummary = vi.fn(successfulSummary);
    const { manager, messages, input } = await fixture(generateSummary);
    for (let i = 0; i < 3; i++) {
      const old = await messages.createMessage({
        sessionId: "s",
        role: "assistant",
        agent: "primary",
      });
      await messages.appendPart(old.id, {
        type: "tool",
        tool: "read",
        callId: `old-${String(i)}`,
        state: {
          status: "completed",
          input: { path: `file-${String(i)}` },
          output: `TOOL-${String(i)}:` + "ORIGINAL".repeat(3000),
        },
      });
    }
    const latest = await messages.createMessage({
      sessionId: "s",
      role: "user",
      agent: "primary",
    });
    await messages.appendPart(latest.id, { type: "text", text: "continue" });
    const normal = await manager.prepareTurn({ ...input, force: false });
    expect(JSON.stringify(normal.request.messages)).toContain(
      "TOOL-0:" + "ORIGINAL".repeat(3000),
    );
    if (entry === "force") await manager.prepareTurn(input);
    else await manager.compact(input.sessionId, input);
    expect(generateSummary).toHaveBeenCalledOnce();
    expect(
      generateSummary.mock.calls[0][0].request.messages.slice(0, -1),
    ).toEqual(normal.request.messages);
  },
);

it.each([-1, 0, 1])(
  "checks the actual summary send boundary with %i token headroom",
  async (headroom) => {
    let window = 128000;
    const counter = createHeuristicTokenCounter({ defaultLimit: window });
    const generateSummary = vi.fn(successfulSummary);
    const { manager, input } = await fixture(generateSummary, {
      tokenCounter: {
        ...counter,
        getBudget(model, options) {
          return createHeuristicTokenCounter({
            defaultLimit: window,
          }).getBudget(model, options);
        },
        getLimit: () => window,
      },
    });
    const normal = await manager.prepareTurn({ ...input, force: false });
    const summaryTokens = estimatePreparedRequestHeuristic(
      {
        ...normal.request,
        messages: [
          ...normal.request.messages,
          { role: "user", content: COMPRESSION_PROMPT },
        ],
      },
      counter,
    );
    window = summaryTokens + 16384 + 1024 + headroom;
    const result = await manager.prepareTurn(input);
    expect(result.compaction?.status).toBe("compacted");
    expect(generateSummary).toHaveBeenCalledOnce();
    const sent = generateSummary.mock.calls[0][0].request;
    expect(
      estimatePreparedRequestHeuristic(sent, counter) +
        (sent.settings?.maxTokens ?? 0) +
        1024,
    ).toBeLessThanOrEqual(window);
    if (headroom < 0)
      expect(sent.messages.length).toBeLessThan(
        normal.request.messages.length + 1,
      );
  },
);

it.each([
  [128000, "none", 16384],
  [200000, "effort", 32768],
] as const)(
  "actually summarizes growing history before capacity is exhausted (window=%i, reasoning=%s)",
  async (window, mode, summaryOutput) => {
    const generateSummary = vi.fn(successfulSummary);
    const counter = createHeuristicTokenCounter({ defaultLimit: window });
    const { manager, messages, input } = await fixture(
      generateSummary,
      {
        tokenCounter: {
          ...counter,
          estimateTokens: (content) => content.length,
        },
      },
      100,
    );
    const requestSettings = {
      ...input.requestSettings,
      maxTokens: 8192,
      reasoning: { ...input.requestSettings.reasoning, mode },
    };
    let triggered = false;
    for (let step = 0; step < 100; step++) {
      const result = await manager.prepareTurn({
        ...input,
        force: false,
        requestSettings,
      });
      if (result.compaction) {
        expect(result.compaction.status).toBe("compacted");
        expect(
          result.compaction.usageBefore.currentTokens / window,
        ).toBeLessThan(0.9);
        expect(generateSummary).toHaveBeenCalledOnce();
        const request = generateSummary.mock.calls[0][0].request;
        expect(request.settings?.maxTokens).toBe(summaryOutput);
        const summaryInput = estimatePreparedRequestHeuristic(request, {
          estimateTokens: (content) => content.length,
        });
        expect(summaryInput).toBeLessThanOrEqual(window - summaryOutput - 1024);
        expect(summaryInput + 8192).toBeGreaterThanOrEqual(
          window - summaryOutput - 1024,
        );
        triggered = true;
        break;
      }
      const message = await messages.createMessage({
        sessionId: input.sessionId,
        role: step % 2 ? "assistant" : "user",
        agent: "primary",
      });
      await messages.appendPart(message.id, {
        type: "text",
        text: "x".repeat(2048),
      });
    }
    expect(triggered).toBe(true);
  },
);

it.each([-1, 0, 1])(
  "checks automatic early capacity at %i token headroom",
  async (headroom) => {
    let window = 128000;
    const counter = createHeuristicTokenCounter({ defaultLimit: window });
    const generateSummary = vi.fn(successfulSummary);
    const { manager, input } = await fixture(generateSummary, {
      tokenCounter: {
        ...counter,
        getBudget(model, options) {
          return createHeuristicTokenCounter({
            defaultLimit: window,
          }).getBudget(model, options);
        },
        getLimit: () => window,
      },
    });
    const normal = await manager.prepareTurn({ ...input, force: false });
    const summaryInput = estimatePreparedRequestHeuristic(
      {
        ...normal.request,
        messages: [
          ...normal.request.messages,
          { role: "user", content: COMPRESSION_PROMPT },
        ],
      },
      counter,
    );
    window =
      summaryInput + input.requestSettings.maxTokens + 16384 + 1024 + headroom;
    const result = await manager.prepareTurn({ ...input, force: false });
    expect(result.compaction?.status).toBe(
      headroom <= 0 ? "compacted" : undefined,
    );
    expect(generateSummary).toHaveBeenCalledTimes(headroom <= 0 ? 1 : 0);
  },
);
