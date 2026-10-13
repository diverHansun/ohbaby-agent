import { describe, expect, it, vi, type Mock } from "vitest";
import { createBus } from "../../bus/index.js";
import { createHeuristicTokenCounter } from "../../services/llm-model/tokenCounting.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  isContextSummaryPart,
  type CoreMessage,
  type MessageManager,
} from "../message/index.js";
import { createContextManager } from "./context-manager.js";
import { ContextEvent } from "./events.js";
import type {
  CompactResult,
  ContextLLMClient,
  PreparedModelRequest,
  PrepareTurnInput,
} from "./types.js";

const input = {
  sessionId: "s",
  directory: "/repo",
  modelId: "m",
  toolNames: [],
  tools: undefined,
  force: true,
  requestSettings: { model: "m", maxTokens: 4096 },
} as const;

async function fixture(
  window = 128000,
  sizes = Array<number>(8).fill(6000),
  compressionThreshold?: number,
): Promise<{
  manager: ReturnType<typeof createContextManager>;
  messages: MessageManager;
  append: (text: string, summary?: boolean) => Promise<CoreMessage>;
  generate: Mock<ContextLLMClient["generateSummary"]>;
  requests: PreparedModelRequest[];
  bus: ReturnType<typeof createBus>;
  setWindow: (value: number) => void;
}> {
  const bus = createBus();
  const messages = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
  });
  async function append(text: string, summary = false): Promise<CoreMessage> {
    const message = await messages.createMessage({
      sessionId: "s",
      agent: "primary",
      role: "assistant",
    });
    await messages.appendPart(message.id, {
      type: "text",
      text,
      ...(summary
        ? { metadata: { kind: "context-summary" }, synthetic: true }
        : {}),
    });
    return message;
  }
  for (const [i, size] of sizes.entries())
    await append(`${String(i)}:` + "x".repeat(size));
  const requests: PreparedModelRequest[] = [];
  const generate = vi.fn<ContextLLMClient["generateSummary"]>((request) => {
    requests.push(request.request);
    return Promise.resolve({
      text: "checkpoint",
      summaryMessageId: request.summaryMessageId,
      requests: [
        {
          requestId: `r${String(request.attempt)}`,
          messageId: request.summaryMessageId,
          compactionId: request.compactionId,
          purpose: "context-summary",
          attempt: request.attempt,
          startedAt: 1,
          endedAt: 2,
          outcome: "success",
        },
      ],
    });
  });
  let currentWindow = window;
  const counter = createHeuristicTokenCounter({ defaultLimit: window });
  const manager = createContextManager({
    bus,
    compressionThreshold,
    messageManager: messages,
    llmClient: { generateSummary: generate },
    memory: {
      load: () => Promise.resolve({ global: "", project: "", merged: "" }),
    },
    systemPromptProvider: { build: () => Promise.resolve("SYSTEM") },
    tokenCounter: {
      ...counter,
      estimateTokens: (text) => text.length,
      getLimit: () => currentWindow,
      getBudget: (model, options) =>
        createHeuristicTokenCounter({ defaultLimit: currentWindow }).getBudget(
          model,
          options,
        ),
    },
  });
  return {
    manager,
    messages,
    append,
    generate,
    requests,
    bus,
    setWindow: (value: number): void => {
      currentWindow = value;
    },
  };
}

const entries = ["manual", "automatic", "force"] as const;

async function invokeCompaction(
  f: Awaited<ReturnType<typeof fixture>>,
  entry: (typeof entries)[number],
  options: Partial<PrepareTurnInput> = {},
): Promise<CompactResult> {
  if (entry === "manual")
    return f.manager.compact("s", { ...input, ...options });
  const result = await f.manager.prepareTurn({
    ...input,
    ...options,
    force: entry === "force",
  });
  if (!result.compaction)
    throw new Error(`${entry} did not attempt compaction`);
  return result.compaction;
}

describe("compaction candidate plan", () => {
  it("keeps a sub-20K history unchanged without asking for a summary", async () => {
    const f = await fixture(64000, [1000, 1000, 1000, 1000]);
    const before = await f.messages.listBySession("s");
    expect((await f.manager.compact("s", input)).status).toBe("not-needed");
    expect(f.generate).not.toHaveBeenCalled();
    expect(await f.messages.listBySession("s")).toEqual(before);
  });

  it("reports ordinary capacity failure without asking for a summary when no older group exists", async () => {
    const f = await fixture(64000, [4000]);
    const before = await f.messages.listBySession("s");
    const result = await f.manager.compact("s", {
      ...input,
      requestSettings: { model: "m", maxTokens: 62000 },
    });
    expect(result).toMatchObject({
      status: "failed",
      compression: { status: "skipped", reason: "too-short" },
    });
    expect(result.error).toMatch(/ordinary request.*budget/iu);
    expect(f.generate).not.toHaveBeenCalled();
    expect(await f.messages.listBySession("s")).toEqual(before);
  });

  it.each(entries)(
    "does not commit when Stop arrives while the message mutation is queued [%s]",
    async (entry) => {
      const f = await fixture(128000, Array<number>(8).fill(6000), 0);
      const controller = new AbortController();
      const before = await f.messages.listBySession("s");
      const originalCommit = f.messages.commitCompaction.bind(f.messages);
      f.messages.commitCompaction = (
        value,
      ): ReturnType<MessageManager["commitCompaction"]> => {
        controller.abort();
        return originalCommit(value);
      };
      await expect(
        invokeCompaction(f, entry, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(await f.messages.listBySession("s")).toEqual(before);
    },
  );

  it("counts protected input once while shrinking a calibrated post-summary request", async () => {
    const f = await fixture();
    const message = await f.messages.createMessage({
      sessionId: "s",
      agent: "primary",
      role: "user",
      runId: "run",
      runtimeInput: {
        inputId: "new-input",
        kind: "user-steer",
        targetRunId: "run",
        sourceId: "prompt",
      },
    });
    await f.messages.appendPart(message.id, {
      type: "text",
      text: "protected".repeat(300),
    });
    const protectedInput = (await f.messages.listBySession("s")).find(
      (item) => item.info.id === message.id,
    );
    if (!protectedInput) throw new Error("Missing protected input fixture");
    f.manager.updateCalibrationFactor("s", 2, 1);
    const result = await f.manager.prepareTurn({
      ...input,
      runId: "run",
      protectedInputs: [protectedInput],
      requestSettings: { model: "m", maxTokens: 110000 },
    });
    expect(result.compaction?.status).toBe("compacted");
    expect(result.usage.currentTokens + 110000 + 1024).toBeLessThanOrEqual(
      128000,
    );
    expect(f.generate).toHaveBeenCalledOnce();
    expect(f.generate.mock.calls[0][0].request.inputIds).toEqual(["new-input"]);
    expect(result.request.inputIds).toEqual(["new-input"]);
    expect(
      result.request.messages.filter(
        (part) => part.content === "protected".repeat(300),
      ),
    ).toHaveLength(1);
    expect(
      (await f.messages.listBySession("s")).find(
        (item) => item.info.id === message.id,
      )?.parts,
    ).toEqual(protectedInput.parts);
  });

  it.each(entries)(
    "replaces every active old summary and stores the successful request on the new summary [%s]",
    async (entry) => {
      const f = await fixture(128000, Array<number>(8).fill(6000), 0);
      await f.append("old constraint A", true);
      await f.append("old constraint B", true);
      const result = await invokeCompaction(f, entry);
      expect(result.status).toBe("compacted");
      expect(JSON.stringify(f.requests[0])).toContain("old constraint A");
      expect(JSON.stringify(f.requests[0])).toContain("old constraint B");
      const history = await f.messages.listBySession("s");
      const active = history
        .flatMap((message) => message.parts)
        .filter((part) => part.time?.compacted === undefined);
      expect(active.filter(isContextSummaryPart)).toHaveLength(1);
      const summaryId =
        result.compression?.status === "compressed"
          ? result.compression.summaryMessageId
          : undefined;
      const summary = history.find((message) => message.info.id === summaryId);
      expect(summary?.info).toMatchObject({
        modelRequests: [{ purpose: "context-summary", outcome: "success" }],
      });
      expect(active.filter((part) => !isContextSummaryPart(part))).toHaveLength(
        3,
      );
    },
  );

  it.each(entries)(
    "trims only older groups for summary capacity and persists exact omitted part IDs [%s]",
    async (entry) => {
      const f = await fixture(40000, Array<number>(8).fill(6000), 0);
      await f.append("inherited constraint", true);
      const before = await f.messages.listBySession("s");
      const result = await invokeCompaction(f, entry);
      expect(result.status).toBe("compacted");
      expect(f.requests).toHaveLength(1);
      const sent = JSON.stringify(f.requests[0]);
      expect(sent).toContain("inherited constraint");
      const omitted = before
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text" && !sent.includes(part.text))
        .map((part) => part.id);
      expect(omitted.length).toBeGreaterThan(0);
      const history = await f.messages.listBySession("s");
      const summary = history
        .flatMap((message) => message.parts)
        .find(
          (part) =>
            isContextSummaryPart(part) && part.time?.compacted === undefined,
        );
      expect(summary).toMatchObject({
        metadata: {
          omittedPartIds: omitted,
          omissionReason: "summary-capacity",
        },
      });
      expect(result).toMatchObject({ omittedParts: omitted.length });
      expect(summary?.type === "text" ? summary.text : "").toContain("omitted");
      expect(
        history
          .flatMap((message) => message.parts)
          .filter((part) => omitted.includes(part.id))
          .every((part) => part.time?.compacted !== undefined),
      ).toBe(true);
    },
  );

  it.each(entries)(
    "uses the full ordinary output reservation to shrink the tail once without another summary request [%s]",
    async (entry) => {
      const f = await fixture(128000, Array<number>(8).fill(6000), 0);
      const result = await invokeCompaction(f, entry, {
        ...input,
        requestSettings: { model: "m", maxTokens: 114000 },
      });
      expect(result.status).toBe("compacted");
      expect(f.requests).toHaveLength(1);
      expect(
        result.usageAfter.currentTokens + 114000 + 1024,
      ).toBeLessThanOrEqual(128000);
      const active = (await f.messages.listBySession("s"))
        .flatMap((message) => message.parts)
        .filter(
          (part) =>
            part.time?.compacted === undefined && !isContextSummaryPart(part),
        );
      expect(active).toHaveLength(2);
      expect(result.omittedParts ?? 0).toBe(0);
    },
  );

  it.each(entries)(
    "fails locally with the original history intact when the most recent group cannot fit [%s]",
    async (entry) => {
      const f = await fixture(128000, [10000, 10000, 10000, 25000], 0);
      const before = await f.messages.listBySession("s");
      const result = await invokeCompaction(f, entry, {
        ...input,
        requestSettings: { model: "m", maxTokens: 110000 },
      });
      expect(result.status).toBe("failed");
      expect(f.generate).toHaveBeenCalledOnce();
      expect(await f.messages.listBySession("s")).toEqual(before);
    },
  );

  it("keeps a committed success with protected input when new input and Stop arrive after the transaction", async () => {
    const f = await fixture();
    const inputMessage = await f.messages.createMessage({
      sessionId: "s",
      agent: "primary",
      role: "user",
      runId: "run",
      runtimeInput: {
        inputId: "late-protected",
        kind: "user-steer",
        targetRunId: "run",
        sourceId: "prompt",
      },
    });
    await f.messages.appendPart(inputMessage.id, {
      type: "text",
      text: "pending instruction",
    });
    const protectedInput = (await f.messages.listBySession("s")).find(
      (message) => message.info.id === inputMessage.id,
    );
    if (!protectedInput) throw new Error("Missing protected input fixture");
    const controller = new AbortController();
    const originalCommit = f.messages.commitCompaction.bind(f.messages);
    f.messages.commitCompaction = async (
      value,
    ): ReturnType<MessageManager["commitCompaction"]> => {
      const committed = await originalCommit(value);
      await f.append("late input".repeat(15000));
      controller.abort();
      return committed;
    };
    const finished: unknown[] = [];
    f.bus.subscribe(ContextEvent.CompactionFinished, (event) => {
      finished.push(event);
    });
    const result = await f.manager.prepareTurn({
      ...input,
      runId: "run",
      protectedInputs: [protectedInput],
      signal: controller.signal,
    });
    expect(result.compaction?.status).toBe("compacted");
    expect(finished).toContainEqual(
      expect.objectContaining({ outcome: "success", status: "compacted" }),
    );
    expect(JSON.stringify(result.request.messages)).toContain("late input");
    const summary = (await f.messages.listBySession("s"))
      .flatMap((message) => message.parts)
      .find(isContextSummaryPart);
    expect(summary?.metadata?.usageBeforeTokens).toBe(
      result.compaction?.usageBefore.currentTokens,
    );
    expect(summary?.metadata?.usageAfterTokens).toBeLessThan(
      result.compaction?.usageBefore.currentTokens ?? 0,
    );
  });

  it("removes enough whole groups for the provider's reported overflow in the remaining attempt", async () => {
    const f = await fixture();
    f.generate.mockRejectedValueOnce(
      new Error(
        "This model's maximum context length is 128000 tokens. However, you requested 141000 tokens.",
      ),
    );
    expect((await f.manager.compact("s", input)).status).toBe("compacted");
    expect(f.generate).toHaveBeenCalledTimes(2);
    const sent = JSON.stringify(f.generate.mock.calls[1][0].request.messages);
    expect(sent).not.toContain("2:" + "x".repeat(6000));
    expect(sent).toContain("3:" + "x".repeat(6000));
  });

  it.each(
    entries.flatMap((entry) =>
      ["network-first", "overflow-first"].map((order) => ({ entry, order })),
    ),
  )(
    "shares two actual attempts for $order mixed failures [$entry]",
    async ({ entry, order }) => {
      const f = await fixture(128000, Array<number>(8).fill(6000), 0);
      const before = await f.messages.listBySession("s");
      const network = Object.assign(new Error("disconnected"), {
        code: "ECONNRESET",
      });
      const overflow = Object.assign(new Error("context length exceeded"), {
        code: "context_length_exceeded",
      });
      f.generate
        .mockRejectedValueOnce(order === "network-first" ? network : overflow)
        .mockRejectedValueOnce(order === "network-first" ? overflow : network);
      expect((await invokeCompaction(f, entry)).status).toBe("failed");
      expect(f.generate).toHaveBeenCalledTimes(2);
      expect(await f.messages.listBySession("s")).toEqual(before);
    },
  );

  it("reserves file-operation text before asking the model for a body", async () => {
    const f = await fixture();
    const old = (await f.messages.listBySession("s"))[0];
    await f.messages.appendPart(old.info.id, {
      type: "tool",
      tool: "read",
      callId: "read-file",
      state: {
        status: "completed",
        input: { path: "source.ts" },
        output: "done",
      },
    });
    f.generate.mockImplementationOnce((request) =>
      Promise.resolve({
        text: "s".repeat(request.request.settings?.maxTokens ?? 0),
        summaryMessageId: request.summaryMessageId,
        requests: [],
      }),
    );
    const result = await f.manager.compact("s", input);
    expect(result.status).toBe("compacted");
    const cap = f.generate.mock.calls[0][0].request.settings?.maxTokens ?? 0;
    expect(cap).toBeLessThan(16384);
    const part = (await f.messages.listBySession("s"))
      .flatMap((message) => message.parts)
      .find(isContextSummaryPart);
    expect(
      part?.type === "text" ? part.text.length : Infinity,
    ).toBeLessThanOrEqual(16384);
    expect(part?.type === "text" ? part.text : "").toContain("source.ts");
  });

  it("reserves file-operation text for tail groups that Mode B may retire", async () => {
    const f = await fixture();
    const tail = (await f.messages.listBySession("s"))[6];
    await f.messages.appendPart(tail.info.id, {
      type: "tool",
      tool: "read",
      callId: "read-tail-file",
      state: {
        status: "completed",
        input: { path: "tail-source.ts" },
        output: "done",
      },
    });
    f.generate.mockImplementationOnce((request) =>
      Promise.resolve({
        text: "s".repeat(request.request.settings?.maxTokens ?? 0),
        summaryMessageId: request.summaryMessageId,
        requests: [],
      }),
    );
    const result = await f.manager.compact("s", {
      ...input,
      requestSettings: { model: "m", maxTokens: 100000 },
    });
    expect(result.status).toBe("compacted");
    expect(f.generate).toHaveBeenCalledTimes(1);
    const cap = f.generate.mock.calls[0][0].request.settings?.maxTokens ?? 0;
    expect(cap).toBeLessThan(16384);
    const part = (await f.messages.listBySession("s"))
      .flatMap((message) => message.parts)
      .find(isContextSummaryPart);
    expect(part?.type === "text" ? part.text : "").toContain("tail-source.ts");
    expect(
      part?.type === "text" ? part.text.length : Infinity,
    ).toBeLessThanOrEqual(16384);
  });

  it.each(entries)(
    "rejects additions to an existing related group while allowing independent new messages [%s]",
    async (entry) => {
      const f = await fixture(128000, Array<number>(8).fill(6000), 0);
      const old = (await f.messages.listBySession("s"))[0];
      f.generate.mockImplementationOnce(async (request) => {
        await f.messages.appendPart(old.info.id, {
          type: "text",
          text: "new member of existing group",
        });
        return {
          text: "checkpoint",
          summaryMessageId: request.summaryMessageId,
          requests: [],
        };
      });
      expect((await invokeCompaction(f, entry)).status).toBe("failed");
      const parts = (await f.messages.listBySession("s")).flatMap(
        (message) => message.parts,
      );
      expect(parts.some(isContextSummaryPart)).toBe(false);
      expect(parts.every((part) => part.time?.compacted === undefined)).toBe(
        true,
      );
    },
  );

  it("protects unfinished non-native tools before newer messages", async () => {
    const f = await fixture(128000, [30000, 500, 30000]);
    const pending = (await f.messages.listBySession("s"))[1];
    await f.messages.appendPart(pending.info.id, {
      type: "tool",
      tool: "read",
      callId: "pending",
      state: { status: "pending", input: {}, raw: "{}" },
    });
    expect((await f.manager.compact("s", input)).status).toBe("compacted");
    expect(
      (await f.messages.listBySession("s"))
        .find((message) => message.info.id === pending.info.id)
        ?.parts.every((part) => part.time?.compacted === undefined),
    ).toBe(true);
  });

  it("allows three automatic successes with growth and suppresses pressure at the successful occupancy floor", async () => {
    const f = await fixture(64000, Array<number>(8).fill(6000), 0);
    const started = vi.fn();
    for (let round = 0; round < 3; round++) {
      expect(
        (
          await f.manager.prepareTurn({
            ...input,
            force: false,
            onCompactionStarted: started,
          })
        ).compaction?.status,
      ).toBe("compacted");
      const count = started.mock.calls.length;
      expect(
        (
          await f.manager.prepareTurn({
            ...input,
            force: false,
            onCompactionStarted: started,
          })
        ).compaction,
      ).toBeUndefined();
      expect(started).toHaveBeenCalledTimes(count);
      if (round < 2)
        for (let i = 0; i < 5; i++) await f.append("growth".repeat(1000));
    }
    expect(f.generate).toHaveBeenCalledTimes(3);
  });

  it.each(["window", "output", "force"] as const)(
    "does not let the occupancy floor suppress a changed %s condition",
    async (change) => {
      const f = await fixture(128000, Array<number>(8).fill(6000), 0);
      const started = vi.fn();
      const normal = { ...input, force: false, onCompactionStarted: started };
      expect((await f.manager.prepareTurn(normal)).compaction?.status).toBe(
        "compacted",
      );
      await f.manager.prepareTurn(normal);
      expect(started).toHaveBeenCalledOnce();
      if (change === "window") f.setWindow(20000);
      const result = await f.manager.prepareTurn({
        ...normal,
        force: change === "force",
        requestSettings: {
          model: "m",
          maxTokens: change === "output" ? 125000 : 4096,
        },
      });
      expect(started).toHaveBeenCalledTimes(2);
      if (change !== "force") expect(result.compaction?.status).toBe("failed");
    },
  );

  it.each([64000, 200000, 1000000])(
    "uses the same complete 20K tail at a %i window",
    async (window) => {
      const f = await fixture(window, Array<number>(6).fill(12000));
      expect((await f.manager.compact("s", input)).status).toBe("compacted");
      const active = (await f.messages.listBySession("s"))
        .flatMap((message) => message.parts)
        .filter(
          (part) =>
            part.time?.compacted === undefined && !isContextSummaryPart(part),
        );
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ text: "5:" + "x".repeat(12000) });
    },
  );
});
