import { describe, expect, it, vi, type Mock } from "vitest";
import { createBus } from "../../bus/index.js";
import { createHeuristicTokenCounter } from "../../services/llm-model/tokenCounting.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  isContextSummaryPart,
  type CoreMessage,
  type MessageManager,
  type MessageWithParts,
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
  contextScopeId?: string,
): Promise<{
  manager: ReturnType<typeof createContextManager>;
  messages: MessageManager;
  append: (text: string, summary?: boolean) => Promise<CoreMessage>;
  generate: Mock<ContextLLMClient["generateSummary"]>;
  requests: PreparedModelRequest[];
  bus: ReturnType<typeof createBus>;
  setWindow: (value: number) => void;
  input: PrepareTurnInput;
  history: () => ReturnType<MessageManager["listBySession"]>;
}> {
  const bus = createBus();
  const messages = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
  });
  async function append(text: string, summary = false): Promise<CoreMessage> {
    const message = await messages.createMessage({
      sessionId: "s",
      agent: contextScopeId === undefined ? "primary" : "explore",
      contextScopeId,
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
    input: {
      ...input,
      contextScopeId,
      isSubagent: contextScopeId !== undefined,
      agentName: contextScopeId === undefined ? "primary" : "explore",
    },
    history: () => messages.listBySession("s", { contextScopeId }),
    setWindow: (value: number): void => {
      currentWindow = value;
    },
  };
}

const entries = ["manual", "automatic", "force"] as const;
const scopes = [undefined, "child_scope"] as const;
const scopedEntries = entries.flatMap((entry) =>
  scopes.map((scope) => ({ entry, scope })),
);

function expectOriginalPartsPreserved(
  before: readonly MessageWithParts[],
  after: readonly MessageWithParts[],
): void {
  for (const original of before) {
    const stored = after.find(
      (message) => message.info.id === original.info.id,
    );
    // Compaction changes retirement metadata; IDs and complete original content
    // (including tool input/result state) must remain available in the store.
    const content = (message: MessageWithParts | undefined): unknown =>
      message?.parts.map(({ time: _time, ...part }) => part);
    expect(content(stored)).toEqual(content(original));
  }
}

async function invokeCompaction(
  f: Awaited<ReturnType<typeof fixture>>,
  entry: (typeof entries)[number],
  options: Partial<PrepareTurnInput> = {},
): Promise<CompactResult> {
  if (entry === "manual")
    return f.manager.compact("s", { ...f.input, ...options });
  const result = await f.manager.prepareTurn({
    ...f.input,
    ...options,
    force: entry === "force",
  });
  if (!result.compaction)
    throw new Error(`${entry} did not attempt compaction`);
  return result.compaction;
}

describe("compaction candidate plan", () => {
  it("leaves low-pressure history unchanged when manual force is explicitly false", async () => {
    const f = await fixture();
    const before = await f.history();
    const result = await f.manager.compact("s", { ...f.input, force: false });

    expect(result.status).toBe("not-needed");
    expect(result.compression).toBeUndefined();
    expect(await f.history()).toEqual(before);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it.each([undefined, true] as const)(
    "allows manual compaction below automatic pressure [force=%s]",
    async (force) => {
      const f = await fixture();
      const result = await f.manager.compact("s", { ...f.input, force });

      expect(result.status).toBe("compacted");
      expect(result.usageAfter.currentTokens).toBeLessThan(
        result.usageBefore.currentTokens,
      );
      expect(
        (await f.history())
          .flatMap((message) => message.parts)
          .filter(isContextSummaryPart),
      ).toHaveLength(1);
    },
  );

  it("still compacts under capacity pressure when manual force is false", async () => {
    const f = await fixture(64000);
    const result = await f.manager.compact("s", { ...f.input, force: false });

    expect(result.status).toBe("compacted");
    expect(result.usageAfter.currentTokens).toBeLessThan(
      result.usageBefore.currentTokens,
    );
    expect(
      (await f.history())
        .flatMap((message) => message.parts)
        .filter(isContextSummaryPart),
    ).toHaveLength(1);
  });

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

  it.each(scopedEntries)(
    "replaces every active old summary and stores the successful request on the new summary [$entry, scope=$scope]",
    async ({ entry, scope }) => {
      const f = await fixture(128000, Array<number>(8).fill(6000), 0, scope);
      await f.append("old constraint A", true);
      await f.append("old constraint B", true);
      const before = await f.history();
      const result = await invokeCompaction(f, entry);
      expect(result.status).toBe("compacted");
      expect(JSON.stringify(f.requests[0])).toContain("old constraint A");
      expect(JSON.stringify(f.requests[0])).toContain("old constraint B");
      const history = await f.history();
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
      expect(
        active
          .filter((part) => !isContextSummaryPart(part))
          .map((part) => part.id),
      ).toEqual(
        before
          .slice(5, 8)
          .flatMap((message) => message.parts.map((part) => part.id)),
      );
      expect(summary?.parts[0]).toMatchObject({
        metadata: {
          keptIds: before.slice(5, 8).map((message) => message.info.id),
          readIds: expect.arrayContaining(
            before.map((message) => message.info.id),
          ) as unknown,
          omittedPartIds: [],
        },
      });
      expect(
        history
          .slice(8, 10)
          .flatMap((message) => message.parts)
          .every((part) => part.time?.compacted !== undefined),
      ).toBe(true);
      expect(summary?.parts[0].metadata?.readIds).toHaveLength(before.length);
      expectOriginalPartsPreserved(before, history);
    },
  );

  it.each(scopedEntries)(
    "trims only older groups for summary capacity and persists exact omitted part IDs [$entry, scope=$scope]",
    async ({ entry, scope }) => {
      const f = await fixture(40000, Array<number>(8).fill(6000), 0, scope);
      await f.append("inherited constraint", true);
      const before = await f.history();
      const result = await invokeCompaction(f, entry);
      expect(result.status).toBe("compacted");
      expect(f.requests).toHaveLength(1);
      const sent = JSON.stringify(f.requests[0]);
      expect(sent).toContain("inherited constraint");
      // 48K history + 16K summary reservation exceeds 40K: the first five
      // complete 6K groups are omitted; the final three remain readable.
      const omitted = before
        .slice(0, 5)
        .flatMap((message) => message.parts.map((part) => part.id));
      for (const message of before.slice(0, 5))
        expect(sent).not.toContain((message.parts[0] as { text: string }).text);
      for (const message of before.slice(5))
        expect(sent).toContain((message.parts[0] as { text: string }).text);
      const history = await f.history();
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
          keptIds: before.slice(5, 8).map((message) => message.info.id),
          readIds: expect.arrayContaining(
            before.slice(5).map((message) => message.info.id),
          ) as unknown,
        },
      });
      expect(summary?.metadata?.readIds).toHaveLength(4);
      expect(result).toMatchObject({ omittedParts: omitted.length });
      expectOriginalPartsPreserved(before, history);
      expect(
        history.slice(0, before.length).map((message) => message.info.id),
      ).toEqual(before.map((message) => message.info.id));
      expect(
        history
          .flatMap((message) => message.parts)
          .filter(
            (part) =>
              !isContextSummaryPart(part) && part.time?.compacted === undefined,
          )
          .map((part) => part.id),
      ).toEqual(
        before
          .slice(5, 8)
          .flatMap((message) => message.parts.map((part) => part.id)),
      );
      expect(summary?.type === "text" ? summary.text : "").toContain("omitted");
      expect(
        history
          .flatMap((message) => message.parts)
          .filter((part) => omitted.includes(part.id))
          .every((part) => part.time?.compacted !== undefined),
      ).toBe(true);
    },
  );

  it.each(scopedEntries)(
    "uses the full ordinary output reservation to shrink the tail once without another summary request [$entry, scope=$scope]",
    async ({ entry, scope }) => {
      const f = await fixture(128000, Array<number>(8).fill(6000), 0, scope);
      const before = await f.history();
      const result = await invokeCompaction(f, entry, {
        ...f.input,
        requestSettings: { model: "m", maxTokens: 114000 },
      });
      expect(result.status).toBe("compacted");
      expect(f.requests).toHaveLength(1);
      expect(
        result.usageAfter.currentTokens + 114000 + 1024,
      ).toBeLessThanOrEqual(128000);
      const active = (await f.history())
        .flatMap((message) => message.parts)
        .filter(
          (part) =>
            part.time?.compacted === undefined && !isContextSummaryPart(part),
        );
      expect(active.map((part) => part.id)).toEqual(
        before
          .slice(6)
          .flatMap((message) => message.parts.map((part) => part.id)),
      );
      const history = await f.history();
      expect(
        history.slice(0, before.length).map((message) => message.info.id),
      ).toEqual(before.map((message) => message.info.id));
      expect(
        history
          .slice(0, 6)
          .flatMap((message) => message.parts)
          .every((part) => part.time?.compacted !== undefined),
      ).toBe(true);
      expect(result.omittedParts ?? 0).toBe(0);
      expect(
        history.flatMap((message) => message.parts).find(isContextSummaryPart),
      ).toMatchObject({
        metadata: {
          keptIds: before.slice(6).map((message) => message.info.id),
          readIds: expect.arrayContaining(
            before.map((message) => message.info.id),
          ) as unknown,
          omittedPartIds: [],
        },
      });
      expect(
        history.flatMap((message) => message.parts).find(isContextSummaryPart)
          ?.metadata?.readIds,
      ).toHaveLength(before.length);
      expectOriginalPartsPreserved(before, history);
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

  it.each(scopes)(
    "allows three automatic successes with growth and suppresses pressure at the successful occupancy floor [scope=%s]",
    async (scope) => {
      const f = await fixture(64000, Array<number>(8).fill(6000), 0, scope);
      const started = vi.fn();
      for (let round = 0; round < 4; round++) {
        expect(
          (
            await f.manager.prepareTurn({
              ...f.input,
              force: false,
              onCompactionStarted: started,
            })
          ).compaction?.status,
        ).toBe("compacted");
        const count = started.mock.calls.length;
        expect(
          (
            await f.manager.prepareTurn({
              ...f.input,
              force: false,
              onCompactionStarted: started,
            })
          ).compaction,
        ).toBeUndefined();
        expect(started).toHaveBeenCalledTimes(count);
        if (round < 3)
          for (let i = 0; i < 5; i++) await f.append("growth".repeat(1000));
      }
      expect(f.generate).toHaveBeenCalledTimes(4);
      expect(
        (await f.history())
          .flatMap((message) => message.parts)
          .filter(
            (part) =>
              isContextSummaryPart(part) && part.time?.compacted === undefined,
          ),
      ).toHaveLength(1);
    },
  );

  it("keeps the automatic occupancy floor separate for sibling scopes in one child session", async () => {
    const f = await fixture(64000, [30000, 30000, 30000], 0.3, "scope_a");
    for (let index = 0; index < 4; index++) {
      const message = await f.messages.createMessage({
        sessionId: "s",
        contextScopeId: "scope_b",
        agent: "explore",
        role: "assistant",
      });
      await f.messages.appendPart(message.id, {
        type: "text",
        text: `b${String(index)}:` + "b".repeat(6000),
      });
    }
    const scopeBBefore = await f.messages.listBySession("s", {
      contextScopeId: "scope_b",
    });
    const a = await f.manager.prepareTurn({ ...f.input, force: false });
    expect(a.compaction?.status).toBe("compacted");
    expect(a.usage.currentTokens).toBeGreaterThan(30000);
    const scopeAAfter = await f.history();
    const b = await f.manager.prepareTurn({
      ...f.input,
      contextScopeId: "scope_b",
      force: false,
    });
    expect(b.compaction?.status).toBe("compacted");
    // B's 24K history is above the 19.2K auto threshold, below A's 30K floor.
    expect(b.compaction?.usageBefore.currentTokens).toBeGreaterThan(19200);
    expect(b.compaction?.usageBefore.currentTokens).toBeLessThan(
      a.usage.currentTokens,
    );
    const scopeBAfter = await f.messages.listBySession("s", {
      contextScopeId: "scope_b",
    });
    expect(
      scopeBAfter
        .filter((message) =>
          message.parts.some(
            (part) =>
              part.time?.compacted === undefined && !isContextSummaryPart(part),
          ),
        )
        .map((message) => message.info.id),
    ).toEqual(scopeBBefore.slice(1).map((message) => message.info.id));
    expect(await f.history()).toEqual(scopeAAfter);
    const repeated = await f.manager.prepareTurn({
      ...f.input,
      contextScopeId: "scope_b",
      force: false,
    });
    expect(repeated.compaction).toBeUndefined();
    expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, true] as const)(
    "bypasses the same child scope floor only for forced manual compaction [force=%s]",
    async (force) => {
      const f = await fixture(
        64000,
        Array<number>(8).fill(6000),
        0,
        "child_scope",
      );
      expect(
        (await f.manager.prepareTurn({ ...f.input, force: false })).compaction
          ?.status,
      ).toBe("compacted");
      const before = await f.history();
      const skipped: string[] = [];
      f.bus.subscribe(ContextEvent.CompactSkipped, (event) => {
        skipped.push(event.reason);
      });
      expect(
        (await f.manager.prepareTurn({ ...f.input, force: false })).compaction,
      ).toBeUndefined();
      expect(skipped).toEqual(["not-needed"]);
      const unforced = await f.manager.compact("s", {
        ...f.input,
        force: false,
      });
      expect(unforced.status).toBe("not-needed");
      expect(unforced.compression).toBeUndefined();
      expect(skipped).toEqual(["not-needed", "not-needed"]);
      const manual = await f.manager.compact("s", { ...f.input, force });
      // The unchanged successful tail has no older group to summarize. The manual
      // entry still evaluates it instead of returning at the automatic floor.
      expect(manual).toMatchObject({
        status: "not-needed",
        compression: { status: "skipped", reason: "too-short" },
      });
      expect(skipped).toEqual(["not-needed", "not-needed", "too-short"]);
      expect(await f.history()).toEqual(before);
    },
  );

  it.each([
    {
      name: "latest oversized complete group",
      sizes: [10000, 10000, 30000],
      toolIndex: 2,
      status: "completed",
      keptIndices: [2],
    },
    {
      name: "unfinished dependency and newer whole groups",
      sizes: [30000, 500, 30000],
      toolIndex: 1,
      status: "pending",
      keptIndices: [1, 2],
    },
  ] as const)(
    "allows the 20K tail budget to expand for $name in a child scope",
    async ({ sizes, toolIndex, status, keptIndices }) => {
      const f = await fixture(128000, [...sizes], 0, "child_scope");
      const initial = await f.history();
      const toolOwner = initial[toolIndex];
      await f.messages.appendPart(toolOwner.info.id, {
        type: "tool",
        tool: "read",
        callId: "paired-read",
        state:
          status === "completed"
            ? {
                status: "completed",
                input: { path: "tail.ts" },
                output: "paired result",
              }
            : { status: "pending", input: { path: "tail.ts" }, raw: "{}" },
      });
      const before = await f.history();
      const result = await f.manager.compact("s", f.input);
      expect(result.status).toBe("compacted");
      const expectedKept = keptIndices.map((index) => before[index]);
      const after = await f.history();
      const active = after.filter((message) =>
        message.parts.some(
          (part) =>
            !isContextSummaryPart(part) && part.time?.compacted === undefined,
        ),
      );
      expect(active.map((message) => message.info.id)).toEqual(
        expectedKept.map((message) => message.info.id),
      );
      expect(
        active.flatMap((message) => message.parts.map((part) => part.id)),
      ).toEqual(
        expectedKept.flatMap((message) => message.parts.map((part) => part.id)),
      );
      expect(
        after.slice(0, before.length).map((message) => message.info.id),
      ).toEqual(before.map((message) => message.info.id));
      expect(
        active.find((message) => message.info.id === toolOwner.info.id)?.parts,
      ).toEqual(before[toolIndex].parts);
      expectOriginalPartsPreserved(before, after);
      expect(
        after.flatMap((message) => message.parts).find(isContextSummaryPart),
      ).toMatchObject({
        metadata: {
          keptIds: expectedKept.map((message) => message.info.id),
          omittedPartIds: [],
        },
      });
      expect(result.usageAfter.currentTokens).toBeGreaterThan(20000);
      const request = await f.manager.prepareTurn({ ...f.input, force: false });
      const wire = JSON.stringify(request.request.messages);
      if (status === "completed") {
        expect(wire).toContain("paired-read");
        expect(wire).toContain("paired result");
      }
    },
  );

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
