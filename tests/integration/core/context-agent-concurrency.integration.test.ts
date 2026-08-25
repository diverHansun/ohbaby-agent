import { setImmediate as waitForImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import type { BusInstance } from "../../../packages/ohbaby-agent/src/bus/types.js";
import {
  ContextEvent,
  createContextManager,
  type ContextLLMClient,
  type ContextManager,
} from "../../../packages/ohbaby-agent/src/core/context/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  isContextSummaryPart,
  type MessageIdGenerator,
  type MessageManager,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => {
    throw new Error("Deferred was not initialized");
  };
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createIds(): MessageIdGenerator {
  let message = 0;
  let part = 0;
  return {
    messageId: () => `concurrency-message-${String(++message)}`,
    partId: () => `concurrency-part-${String(++part)}`,
  };
}

function createManager(
  messageManager: MessageManager,
  generateSummary: ContextLLMClient["generateSummary"],
  options: {
    readonly bus?: BusInstance;
    readonly contextLimit?: number;
  } = {},
): ContextManager {
  return createContextManager({
    bus: options.bus ?? createBus(),
    llmClient: { generateSummary },
    memory: {
      load: () => Promise.resolve({ global: "", merged: "", project: "" }),
    },
    messageManager,
    pruneMinimumTokens: Number.MAX_SAFE_INTEGER,
    systemPromptProvider: {
      build: () => Promise.resolve("stable"),
    },
    tokenCounter: {
      estimateTokens: (content) => content.length,
      getLimit: () => options.contextLimit ?? 20_000,
    },
  });
}

async function appendHistory(
  messageManager: MessageManager,
  input: {
    readonly contextScopeId?: string;
    readonly sessionId: string;
    readonly sentinel: string;
  },
): Promise<void> {
  for (const [index, role] of [
    "user",
    "assistant",
    "user",
    "assistant",
  ].entries()) {
    const message = await messageManager.createMessage({
      ...(input.contextScopeId === undefined
        ? {}
        : { contextScopeId: input.contextScopeId }),
      agent: "test",
      role: role as "assistant" | "user",
      sessionId: input.sessionId,
    });
    await messageManager.appendPart(message.id, {
      text: `${input.sentinel}-${String(index)} ${"history ".repeat(80)}`,
      type: "text",
    });
  }
}

function compact(
  manager: ContextManager,
  sessionId: string,
  contextScopeId?: string,
) {
  return manager.compact(sessionId, {
    ...(contextScopeId === undefined ? {} : { contextScopeId }),
    directory: "/repo",
    force: true,
    isSubagent: contextScopeId !== undefined,
    modelId: "fake-model",
    toolNames: [],
    tools: undefined,
  });
}

function prepare(
  manager: ContextManager,
  sessionId: string,
  contextScopeId?: string,
) {
  return manager.prepareTurn({
    ...(contextScopeId === undefined ? {} : { contextScopeId }),
    directory: "/repo",
    isSubagent: contextScopeId !== undefined,
    modelId: "fake-model",
    sessionId,
    toolNames: [],
    tools: undefined,
  });
}

async function summaryCount(
  messageManager: MessageManager,
  sessionId: string,
  contextScopeId?: string,
): Promise<number> {
  const history = await messageManager.listBySession(sessionId, {
    contextScopeId,
  });
  return history.filter((message) => message.parts.some(isContextSummaryPart))
    .length;
}

describe("context scoped mutation coordination", () => {
  it("serializes two same-scope manual compactions through one exclusive lane", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      idGenerator: createIds(),
      store: createInMemoryMessageStore(),
    });
    await appendHistory(messageManager, {
      contextScopeId: "scope_a",
      sentinel: "scope-a",
      sessionId: "shared_1",
    });
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockImplementation(async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        return "scope-a-summary";
      });
    const manager = createManager(messageManager, generateSummary);

    const first = compact(manager, "shared_1", "scope_a");
    await firstStarted.promise;
    const second = compact(manager, "shared_1", "scope_a");
    await waitForImmediate();

    expect(generateSummary).toHaveBeenCalledOnce();
    releaseFirst.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe("compacted");
    expect(secondResult.status).toBe("not-needed");
    expect(generateSummary).toHaveBeenCalledOnce();
    await expect(
      summaryCount(messageManager, "shared_1", "scope_a"),
    ).resolves.toBe(1);
  });

  it("treats a cross-manager compaction conflict as stale", async () => {
    const baseMessageManager = createMessageManager({
      bus: createBus(),
      idGenerator: createIds(),
      store: createInMemoryMessageStore(),
    });
    await appendHistory(baseMessageManager, {
      contextScopeId: "scope_a",
      sentinel: "scope-a",
      sessionId: "shared_1",
    });
    const bothAtCommit = deferred<void>();
    const releaseCommits = deferred<void>();
    let commitCount = 0;
    const withCommitBarrier = (): MessageManager => ({
      ...baseMessageManager,
      async commitCompaction(input) {
        commitCount += 1;
        if (commitCount === 2) {
          bothAtCommit.resolve();
        }
        await releaseCommits.promise;
        return baseMessageManager.commitCompaction(input);
      },
    });
    const firstManager = createManager(
      withCommitBarrier(),
      async () => "first-summary",
    );
    const secondManager = createManager(
      withCommitBarrier(),
      async () => "second-summary",
    );

    const first = compact(firstManager, "shared_1", "scope_a");
    const second = compact(secondManager, "shared_1", "scope_a");
    await bothAtCommit.promise;
    releaseCommits.resolve();

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "compacted",
      "not-needed",
    ]);
    expect(
      results.some(
        (result) =>
          result.compression?.status === "skipped" &&
          result.compression.reason === "stale",
      ),
    ).toBe(true);
    await expect(
      summaryCount(baseMessageManager, "shared_1", "scope_a"),
    ).resolves.toBe(1);
  });

  it("does not compact a selected part that changed before commit", async () => {
    const baseMessageManager = createMessageManager({
      bus: createBus(),
      idGenerator: createIds(),
      store: createInMemoryMessageStore(),
    });
    await appendHistory(baseMessageManager, {
      contextScopeId: "scope_a",
      sentinel: "scope-a",
      sessionId: "shared_1",
    });
    const commitReached = deferred<void>();
    const releaseCommit = deferred<void>();
    let selectedPartId = "";
    const barrierMessageManager: MessageManager = {
      ...baseMessageManager,
      async commitCompaction(input) {
        selectedPartId = input.expectedParts[0]?.id ?? "";
        commitReached.resolve();
        await releaseCommit.promise;
        return baseMessageManager.commitCompaction(input);
      },
    };
    const manager = createManager(
      barrierMessageManager,
      async () => "candidate-summary",
    );

    const resultPromise = compact(manager, "shared_1", "scope_a");
    await commitReached.promise;
    expect(selectedPartId).not.toBe("");
    await baseMessageManager.updatePart(selectedPartId, {
      text: "updated-before-commit",
    });
    releaseCommit.resolve();

    const result = await resultPromise;
    expect(result).toMatchObject({
      compression: { reason: "stale", status: "skipped" },
      status: "not-needed",
    });
    await expect(
      summaryCount(baseMessageManager, "shared_1", "scope_a"),
    ).resolves.toBe(0);
    const history = await baseMessageManager.listBySession("shared_1", {
      contextScopeId: "scope_a",
    });
    const selectedPart = history
      .flatMap((message) => message.parts)
      .find((part) => part.id === selectedPartId);
    expect(selectedPart).toMatchObject({ text: "updated-before-commit" });
    expect(selectedPart?.time?.compacted).toBeUndefined();
  });

  it("serializes two same-scope automatic prepares", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      idGenerator: createIds(),
      store: createInMemoryMessageStore(),
    });
    await appendHistory(messageManager, {
      contextScopeId: "scope_a",
      sentinel: "scope-a",
      sessionId: "shared_1",
    });
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockImplementation(async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        return "scope-a-summary";
      });
    const manager = createManager(messageManager, generateSummary, {
      contextLimit: 2_000,
    });

    const first = prepare(manager, "shared_1", "scope_a");
    await firstStarted.promise;
    const second = prepare(manager, "shared_1", "scope_a");
    await waitForImmediate();
    expect(generateSummary).toHaveBeenCalledOnce();
    releaseFirst.resolve();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.compaction?.status).toBe("compacted");
    expect(secondResult.compaction?.status).toBe("not-needed");
    expect(secondResult.request.messages).toEqual(firstResult.request.messages);
    expect(generateSummary).toHaveBeenCalledOnce();
  });

  it("serializes a manual compact with a same-scope prompt prepare", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      idGenerator: createIds(),
      store: createInMemoryMessageStore(),
    });
    await appendHistory(messageManager, {
      contextScopeId: "scope_a",
      sentinel: "scope-a",
      sessionId: "shared_1",
    });
    const compactStarted = deferred<void>();
    const releaseCompact = deferred<void>();
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockImplementation(async () => {
        compactStarted.resolve();
        await releaseCompact.promise;
        return "scope-a-summary";
      });
    const manager = createManager(messageManager, generateSummary, {
      contextLimit: 2_000,
    });

    const manual = compact(manager, "shared_1", "scope_a");
    await compactStarted.promise;
    const prompt = prepare(manager, "shared_1", "scope_a");
    await waitForImmediate();
    expect(generateSummary).toHaveBeenCalledOnce();
    releaseCompact.resolve();

    await expect(manual).resolves.toMatchObject({ status: "compacted" });
    const prepared = await prompt;
    expect(prepared.compaction?.status).toBe("not-needed");
    expect(JSON.stringify(prepared.request.messages)).toContain(
      "scope-a-summary",
    );
    expect(JSON.stringify(prepared.request.messages)).not.toContain(
      "scope-a-0",
    );
  });

  it("allows sibling scopes to compact concurrently", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      idGenerator: createIds(),
      store: createInMemoryMessageStore(),
    });
    await appendHistory(messageManager, {
      contextScopeId: "scope_a",
      sentinel: "scope-a",
      sessionId: "shared_1",
    });
    await appendHistory(messageManager, {
      contextScopeId: "scope_b",
      sentinel: "scope-b",
      sessionId: "shared_1",
    });
    const bothStarted = deferred<void>();
    const releaseBoth = deferred<void>();
    const startedScopes: string[] = [];
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockImplementation(async (input) => {
        startedScopes.push(input.contextScopeId ?? "primary");
        if (startedScopes.length === 2) {
          bothStarted.resolve();
        }
        await releaseBoth.promise;
        return `${input.contextScopeId ?? "primary"}-summary`;
      });
    const manager = createManager(messageManager, generateSummary);

    const scopeA = compact(manager, "shared_1", "scope_a");
    const scopeB = compact(manager, "shared_1", "scope_b");
    await bothStarted.promise;
    expect(new Set(startedScopes)).toEqual(new Set(["scope_a", "scope_b"]));
    releaseBoth.resolve();

    await expect(Promise.all([scopeA, scopeB])).resolves.toMatchObject([
      { status: "compacted" },
      { status: "compacted" },
    ]);
  });

  it("keeps a newly appended tail active while compacting the selected prefix", async () => {
    const messageManager = createMessageManager({
      bus: createBus(),
      idGenerator: createIds(),
      store: createInMemoryMessageStore(),
    });
    await appendHistory(messageManager, {
      contextScopeId: "scope_a",
      sentinel: "scope-a",
      sessionId: "shared_1",
    });
    const candidateStarted = deferred<void>();
    const releaseCandidate = deferred<void>();
    const manager = createManager(messageManager, async () => {
      candidateStarted.resolve();
      await releaseCandidate.promise;
      return "prefix-summary";
    });

    const resultPromise = compact(manager, "shared_1", "scope_a");
    await candidateStarted.promise;
    const newMessage = await messageManager.createMessage({
      agent: "test",
      contextScopeId: "scope_a",
      role: "user",
      sessionId: "shared_1",
    });
    await messageManager.appendPart(newMessage.id, {
      text: "arrived-during-summary",
      type: "text",
    });
    releaseCandidate.resolve();

    const result = await resultPromise;
    expect(result.status).toBe("compacted");
    await expect(
      summaryCount(messageManager, "shared_1", "scope_a"),
    ).resolves.toBe(1);
    const history = await messageManager.listBySession("shared_1", {
      contextScopeId: "scope_a",
    });
    expect(JSON.stringify(history)).toContain("arrived-during-summary");
    const appended = history.find(
      (message) => message.info.id === newMessage.id,
    );
    expect(appended?.parts[0]?.time?.compacted).toBeUndefined();
  });

  it("emits one scoped terminal event for each accepted attempt", async () => {
    const bus = createBus();
    const messageManager = createMessageManager({
      bus,
      idGenerator: createIds(),
      store: createInMemoryMessageStore(),
    });
    await appendHistory(messageManager, {
      sentinel: "primary",
      sessionId: "shared_1",
    });
    await appendHistory(messageManager, {
      contextScopeId: "scope_a",
      sentinel: "scope-a",
      sessionId: "shared_1",
    });
    await appendHistory(messageManager, {
      contextScopeId: "scope_b",
      sentinel: "scope-b",
      sessionId: "shared_1",
    });
    const started: {
      readonly attemptId: string;
      readonly contextScopeId?: string;
      readonly sessionId: string;
    }[] = [];
    const finished: {
      readonly attemptId: string;
      readonly contextScopeId?: string;
      readonly outcome: string;
      readonly sessionId: string;
    }[] = [];
    const compressed: {
      readonly attemptId: string;
      readonly contextScopeId?: string;
    }[] = [];
    bus.subscribe(ContextEvent.CompactionStarted, (event) => {
      started.push(event);
    });
    bus.subscribe(ContextEvent.CompactionFinished, (event) => {
      finished.push(event);
    });
    bus.subscribe(ContextEvent.Compressed, (event) => {
      compressed.push(event);
    });
    const manager = createManager(
      messageManager,
      (input) =>
        Promise.resolve(`${input.contextScopeId ?? "primary"}-summary`),
      { bus },
    );

    await Promise.all([
      compact(manager, "shared_1"),
      compact(manager, "shared_1", "scope_a"),
      compact(manager, "shared_1", "scope_b"),
    ]);

    expect(started).toHaveLength(3);
    expect(finished).toHaveLength(3);
    expect(compressed).toHaveLength(3);
    expect(new Set(started.map((event) => event.attemptId)).size).toBe(3);
    for (const start of started) {
      const terminal = finished.filter(
        (event) => event.attemptId === start.attemptId,
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({
        outcome: "success",
        sessionId: start.sessionId,
      });
      expect(terminal[0]?.contextScopeId).toBe(start.contextScopeId);
      const compression = compressed.filter(
        (event) => event.attemptId === start.attemptId,
      );
      expect(compression).toHaveLength(1);
      expect(compression[0]?.contextScopeId).toBe(start.contextScopeId);
    }
    expect(
      new Set(started.map((event) => event.contextScopeId ?? "primary")),
    ).toEqual(new Set(["primary", "scope_a", "scope_b"]));
  });
});
