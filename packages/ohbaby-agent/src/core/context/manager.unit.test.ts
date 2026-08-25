import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  isContextSummaryPart,
  isModelContextPart,
} from "../message/index.js";
import type {
  MessageIdGenerator,
  MessageManager,
  MessageWithParts,
} from "../message/index.js";
import {
  COMPACTION_MIN_REMAINING_INPUT_TOKENS,
  COMPRESSION_THRESHOLD,
  ContextEvent,
  createContextManager,
  decideCompactionRung,
  findCutPoint,
  getContextUsage,
} from "./index.js";
import type {
  CompactOptions,
  ContextManager,
  ContextLLMClient,
  ContextMeasurementPayload,
  MemoryReader,
  PrepareTurnInput,
  SystemPromptProvider,
  TokenCounter,
} from "./types.js";
import { isActivePart } from "./filters.js";
import { serializeHistory } from "./serialization.js";
import { serializeForLlm } from "./serializer.js";
import { isSummaryMessage, partitionSummary } from "./summary.js";
import { estimateWireHeuristic } from "./token-estimation.js";

type WithDefaultToolInput<
  T extends { readonly toolNames: readonly string[]; readonly tools: unknown },
> = Omit<T, "toolNames" | "tools"> & Partial<Pick<T, "toolNames" | "tools">>;

type FixtureContextManager = Omit<ContextManager, "compact" | "prepareTurn"> & {
  compact(
    sessionId: string,
    options: WithDefaultToolInput<CompactOptions>,
  ): ReturnType<ContextManager["compact"]>;
  prepareTurn(
    input: WithDefaultToolInput<PrepareTurnInput>,
  ): ReturnType<ContextManager["prepareTurn"]>;
};

interface ContextFixture {
  readonly compactionFinished: readonly unknown[];
  readonly compactionProgress: readonly unknown[];
  readonly compactSkipped: readonly unknown[];
  readonly compressed: readonly unknown[];
  readonly manager: FixtureContextManager;
  readonly measurements: readonly ContextMeasurementPayload[];
  readonly masked: readonly unknown[];
  readonly memory: MemoryReader;
  readonly pruned: readonly unknown[];
  readonly systemPromptProvider: SystemPromptProvider;
  readonly turnPrepared: readonly unknown[];
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
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
    readonly maskConfig?: Parameters<
      typeof createContextManager
    >[0]["maskConfig"];
    readonly maxCompactionsPerTurn?: number;
    readonly pruneProtectTokens?: number;
    readonly pruneMinimumTokens?: number;
    readonly systemPromptProvider?: SystemPromptProvider;
    readonly thrashWindow?: number;
  } = {},
): ContextFixture {
  const bus = createBus();
  const compactionFinished: unknown[] = [];
  const compactionProgress: unknown[] = [];
  const compactSkipped: unknown[] = [];
  const compressed: unknown[] = [];
  const masked: unknown[] = [];
  const measurements: ContextMeasurementPayload[] = [];
  const pruned: unknown[] = [];
  const turnPrepared: unknown[] = [];
  const memory =
    options.memory ??
    ({
      load: vi.fn().mockResolvedValue({
        global: "global memory",
        project: "project memory",
        merged: "global memory\n---\nproject memory",
      }),
    } satisfies MemoryReader);
  const systemPromptProvider: SystemPromptProvider =
    options.systemPromptProvider ?? {
      build: vi.fn().mockResolvedValue("system prompt"),
    };
  const contextManager = createContextManager({
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
    onRequestMeasured: (request) => measurements.push(request),
    compressionThreshold: options.compressionThreshold,
    maskEnabled: options.maskEnabled,
    maskConfig: options.maskConfig,
    maxCompactionsPerTurn: options.maxCompactionsPerTurn,
    pruneProtectTokens: options.pruneProtectTokens ?? 10,
    pruneMinimumTokens: options.pruneMinimumTokens ?? 5,
    thrashWindow: options.thrashWindow,
  });
  const manager: FixtureContextManager = {
    ...contextManager,
    compact(sessionId, input) {
      return contextManager.compact(sessionId, {
        toolNames: [],
        tools: undefined,
        ...input,
      });
    },
    prepareTurn(input) {
      return contextManager.prepareTurn({
        toolNames: [],
        tools: undefined,
        ...input,
      });
    },
  };

  bus.subscribe(ContextEvent.Compressed, (payload) => {
    compressed.push(payload);
  });
  bus.subscribe(ContextEvent.CompactionFinished, (payload) => {
    compactionFinished.push(payload);
  });
  bus.subscribe(ContextEvent.CompactionProgress, (payload) => {
    compactionProgress.push(payload);
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
  bus.subscribe(ContextEvent.TurnPrepared, (payload) => {
    turnPrepared.push(payload);
  });

  return {
    compactionFinished,
    compactionProgress,
    compactSkipped,
    compressed,
    masked,
    manager,
    measurements,
    memory,
    pruned,
    systemPromptProvider,
    turnPrepared,
  };
}

async function addSummaryOverflowHistory(
  messageManager: MessageManager,
  turns: number,
  contextScopeId?: string,
): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await addTextMessage(messageManager, {
      role: "user",
      sessionId: "session_1",
      text: `user-${String(index)} ${"request ".repeat(20)}`,
      ...(contextScopeId === undefined ? {} : { contextScopeId }),
    });
    await addCompletedToolMessage(messageManager, {
      output: `tool-${String(index)} ${"result ".repeat(20)}`,
      sessionId: "session_1",
      ...(contextScopeId === undefined ? {} : { contextScopeId }),
    });
  }
}

async function addTextMessage(
  messageManager: MessageManager,
  input: {
    readonly contextScopeId?: string;
    readonly sessionId: string;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const message = await messageManager.createMessage({
    ...(input.contextScopeId === undefined
      ? {}
      : { contextScopeId: input.contextScopeId }),
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
    readonly contextScopeId?: string;
    readonly sessionId: string;
    readonly output: string;
  },
): Promise<void> {
  const message = await messageManager.createMessage({
    ...(input.contextScopeId === undefined
      ? {}
      : { contextScopeId: input.contextScopeId }),
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
  return history.filter(isSummaryMessage).length;
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
    ).toBe(
      messages.map((message) => JSON.stringify(message)).join("\n").length,
    );
  });

  it("includes tool schemas in the wire heuristic and ignores empty tools", () => {
    const messages = [{ role: "user" as const, content: "hello" }];
    const tools = [
      {
        function: {
          description: "Read a file",
          name: "read_file",
          parameters: {
            properties: { path: { type: "string" } },
            required: ["path"],
            type: "object",
          },
        },
        type: "function" as const,
      },
    ];
    const tokenCounter = {
      estimateTokens: (content: string): number => content.length,
    };
    const messagesOnly = estimateWireHeuristic(messages, tokenCounter);

    expect(estimateWireHeuristic(messages, tokenCounter, [])).toBe(
      messagesOnly,
    );
    expect(estimateWireHeuristic(messages, tokenCounter, tools)).toBe(
      messagesOnly + 1 + JSON.stringify(tools).length,
    );
  });

  it("includes tool schemas in prepared heuristic and current usage", async () => {
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
    const tools = [
      {
        function: {
          name: "read_file",
          parameters: { type: "object" },
        },
        type: "function" as const,
      },
    ];

    const messagesOnly = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
      toolNames: ["read_file"],
      tools: undefined,
    });
    const withTools = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
      toolNames: ["read_file"],
      tools,
    });

    expect(withTools.request.messages).toEqual(messagesOnly.request.messages);
    expect(withTools.request.tools).toEqual(tools);
    expect(Object.isFrozen(withTools.request)).toBe(true);
    expect(Object.isFrozen(withTools.request.messages)).toBe(true);
    expect(Object.isFrozen(withTools.request.tools)).toBe(true);
    expect(Object.isFrozen(withTools.request.tools?.[0]?.function)).toBe(true);
    expect(Object.isFrozen(tools[0]?.function)).toBe(false);
    expect(() => {
      (
        withTools.request.tools?.[0]?.function.parameters as { type?: string }
      ).type = "array";
    }).toThrow();
    expect(withTools.sentHeuristic).toBeGreaterThan(messagesOnly.sentHeuristic);
    expect(withTools.usage.currentTokens).toBeGreaterThan(
      messagesOnly.usage.currentTokens,
    );

    manager.updateCalibrationFactor(
      "session_1",
      withTools.sentHeuristic * 2,
      withTools.sentHeuristic,
    );
    const calibrated = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
      toolNames: ["read_file"],
      tools,
    });
    expect(calibrated.usage.currentTokens).toBe(
      Math.round(calibrated.sentHeuristic * 1.5),
    );
  });

  it("includes tail directives in the measured request without persisting them", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "finish the work",
    });
    const tokenCounter = {
      estimateTokens: (content: string): number => content.length,
      getLimit: (): number => 10_000,
    } satisfies TokenCounter;
    const { manager, measurements } = createManager({
      messageManager,
      tokenCounter,
    });
    const finalizationMessage = {
      content: "Summarize the completed work without calling tools.",
      role: "system" as const,
    };

    const prepared = await manager.prepareTurn({
      tailDirectives: [finalizationMessage],
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
      toolNames: [],
      tools: [],
    });

    expect(prepared.request.messages.at(-1)).toEqual(finalizationMessage);
    expect(measurements.at(-1)).toEqual(prepared.request);
    expect(prepared.sentHeuristic).toBe(
      estimateWireHeuristic(prepared.request.messages, tokenCounter, []),
    );
    expect(prepared.usage.currentTokens).toBe(prepared.sentHeuristic);
    expect(
      JSON.stringify(await messageManager.listBySession("session_1")),
    ).not.toContain(finalizationMessage.content);
  });

  it("attaches one scoped runtime part and reuses a run-local prompt snapshot", async () => {
    const messageManager = createMessageManagerFixture();
    const user = await messageManager.createMessage({
      agent: "build",
      contextScopeId: "subagent_1",
      id: "user_turn_1",
      role: "user",
      sessionId: "child_1",
    });
    await messageManager.appendPart(user.id, {
      text: "inspect the repository",
      type: "text",
    });
    let systemVersion = 0;
    let runtimeVersion = 0;
    const systemPromptProvider: SystemPromptProvider = {
      build: () => {
        systemVersion += 1;
        return Promise.resolve(`stable-system-${String(systemVersion)}`);
      },
      buildRuntimeContext: () => {
        runtimeVersion += 1;
        return Promise.resolve(
          `<environment_context>runtime-${String(runtimeVersion)}</environment_context>`,
        );
      },
    };
    const { manager } = createManager({
      messageManager,
      systemPromptProvider,
    });

    const promptSnapshot = await manager.createRunPromptSnapshot({
      agentName: "explore",
      contextScopeId: "subagent_1",
      directory: "/repo",
      initiatingUserMessageId: user.id,
      isSubagent: true,
      sessionId: "child_1",
      toolNames: [],
    });
    await manager.createRunPromptSnapshot({
      agentName: "explore",
      contextScopeId: "subagent_1",
      directory: "/repo",
      initiatingUserMessageId: user.id,
      isSubagent: true,
      sessionId: "child_1",
      toolNames: [],
    });
    const first = await manager.prepareTurn({
      agentName: "explore",
      contextScopeId: "subagent_1",
      directory: "/repo",
      isSubagent: true,
      modelId: "model-a",
      promptSnapshot,
      sessionId: "child_1",
      toolNames: [],
      tools: undefined,
    });
    const second = await manager.prepareTurn({
      agentName: "explore",
      contextScopeId: "subagent_1",
      directory: "/changed",
      isSubagent: true,
      modelId: "model-a",
      promptSnapshot,
      sessionId: "child_1",
      toolNames: [],
      tools: undefined,
    });
    const stored = await messageManager.listBySession("child_1", {
      contextScopeId: "subagent_1",
    });
    const runtimeParts = stored
      .flatMap((message) => message.parts)
      .filter(
        (part) =>
          part.type === "text" &&
          part.metadata?.kind === "model-context:runtime:v1",
      );

    expect(runtimeParts).toHaveLength(1);
    expect(runtimeParts[0]).toMatchObject({
      synthetic: true,
      text: expect.stringContaining("runtime-1") as string,
    });
    expect(first.request.messages).toEqual(second.request.messages);
    expect(first.request.messages[0]).toEqual({
      content: "stable-system-1",
      role: "system",
    });
    expect(JSON.stringify(first.request.messages)).toContain("runtime-1");
    expect(JSON.stringify(first.request.messages)).not.toContain("runtime-2");
  });

  it("attaches one runtime part when snapshots race on the same manager", async () => {
    const messageManager = createMessageManagerFixture();
    const user = await messageManager.createMessage({
      agent: "build",
      id: "concurrent_user",
      role: "user",
      sessionId: "session_1",
    });
    await messageManager.appendPart(user.id, {
      text: "concurrent request",
      type: "text",
    });
    const bothBuilding = deferred<undefined>();
    const releaseBuild = deferred<undefined>();
    let builders = 0;
    const { manager } = createManager({
      messageManager,
      systemPromptProvider: {
        build: () => Promise.resolve("stable"),
        buildRuntimeContext: async () => {
          builders += 1;
          if (builders === 2) {
            bothBuilding.resolve(undefined);
          }
          await releaseBuild.promise;
          return `runtime-${String(builders)}`;
        },
      },
    });
    const input = {
      directory: "/repo",
      initiatingUserMessageId: user.id,
      isSubagent: false,
      sessionId: "session_1",
      toolNames: [],
    } as const;

    const first = manager.createRunPromptSnapshot(input);
    const second = manager.createRunPromptSnapshot(input);
    await bothBuilding.promise;
    releaseBuild.resolve(undefined);
    await Promise.all([first, second]);

    const runtimeParts = (await messageManager.listBySession("session_1"))
      .flatMap((message) => message.parts)
      .filter(isModelContextPart);
    expect(builders).toBe(2);
    expect(runtimeParts).toHaveLength(1);
  });

  it("does not attach runtime context for resume and rejects a cross-scope initiating message", async () => {
    const messageManager = createMessageManagerFixture();
    const user = await messageManager.createMessage({
      agent: "explore",
      contextScopeId: "subagent_a",
      id: "user_a",
      role: "user",
      sessionId: "child_1",
    });
    await messageManager.appendPart(user.id, {
      text: "resume me",
      type: "text",
    });
    const buildRuntimeContext = vi.fn().mockResolvedValue("runtime");
    const { manager } = createManager({
      messageManager,
      systemPromptProvider: {
        build: vi.fn().mockResolvedValue("stable"),
        buildRuntimeContext,
      },
    });

    await manager.createRunPromptSnapshot({
      contextScopeId: "subagent_a",
      directory: "/repo",
      isSubagent: true,
      sessionId: "child_1",
      toolNames: [],
    });
    expect(buildRuntimeContext).not.toHaveBeenCalled();

    await expect(
      manager.createRunPromptSnapshot({
        contextScopeId: "subagent_b",
        directory: "/repo",
        initiatingUserMessageId: user.id,
        isSubagent: true,
        sessionId: "child_1",
        toolNames: [],
      }),
    ).rejects.toThrow(/not present in the requested context scope/u);
    expect(buildRuntimeContext).not.toHaveBeenCalled();
  });

  it("resumes a child scope without moving or rewriting its persisted runtime part", async () => {
    const messageManager = createMessageManagerFixture();
    const user = await messageManager.createMessage({
      agent: "explore",
      contextScopeId: "subagent_1",
      id: "child_user",
      role: "user",
      sessionId: "child_session",
    });
    await messageManager.appendPart(user.id, {
      text: "initial child request",
      type: "text",
    });
    let runtimeVersion = 1;
    const buildRuntimeContext = vi.fn(() =>
      Promise.resolve(`child-runtime-${String(runtimeVersion)}`),
    );
    const { manager } = createManager({
      messageManager,
      systemPromptProvider: {
        build: vi.fn().mockResolvedValue("child-stable"),
        buildRuntimeContext,
      },
    });
    const initialSnapshot = await manager.createRunPromptSnapshot({
      agentName: "explore",
      contextScopeId: "subagent_1",
      directory: "/repo",
      initiatingUserMessageId: user.id,
      isSubagent: true,
      sessionId: "child_session",
      toolNames: [],
    });
    const initial = await manager.prepareTurn({
      agentName: "explore",
      contextScopeId: "subagent_1",
      directory: "/repo",
      isSubagent: true,
      modelId: "model-a",
      promptSnapshot: initialSnapshot,
      sessionId: "child_session",
    });
    const storedBeforeResume = structuredClone(
      await messageManager.listBySession("child_session", {
        contextScopeId: "subagent_1",
      }),
    );

    runtimeVersion = 2;
    const resumedSnapshot = await manager.createRunPromptSnapshot({
      agentName: "explore",
      contextScopeId: "subagent_1",
      directory: "/changed",
      isSubagent: true,
      sessionId: "child_session",
      toolNames: [],
    });
    const resumed = await manager.prepareTurn({
      agentName: "explore",
      contextScopeId: "subagent_1",
      directory: "/changed",
      isSubagent: true,
      modelId: "model-a",
      promptSnapshot: resumedSnapshot,
      sessionId: "child_session",
    });

    expect(buildRuntimeContext).toHaveBeenCalledOnce();
    expect(
      await messageManager.listBySession("child_session", {
        contextScopeId: "subagent_1",
      }),
    ).toEqual(storedBeforeResume);
    expect(resumed.request.messages).toEqual(initial.request.messages);
    expect(JSON.stringify(resumed.request)).toContain("child-runtime-1");
    expect(JSON.stringify(resumed.request)).not.toContain("child-runtime-2");
  });

  it("keeps the current run stable and admits changed system, memory, and runtime only on the next user turn", async () => {
    const messageManager = createMessageManagerFixture();
    const firstUser = await messageManager.createMessage({
      agent: "build",
      id: "user_turn_1",
      role: "user",
      sessionId: "session_1",
    });
    await messageManager.appendPart(firstUser.id, {
      text: "first request",
      type: "text",
    });
    let version = 1;
    const { manager } = createManager({
      memory: {
        load: () =>
          Promise.resolve({
            global: "",
            merged: `memory-${String(version)}`,
            project: `memory-${String(version)}`,
          }),
      },
      messageManager,
      systemPromptProvider: {
        build: () => Promise.resolve(`stable-system-${String(version)}`),
        buildRuntimeContext: () =>
          Promise.resolve(
            `<environment_context>runtime-${String(version)}</environment_context>`,
          ),
      },
    });
    const firstSnapshot = await manager.createRunPromptSnapshot({
      directory: "/repo-v1",
      initiatingUserMessageId: firstUser.id,
      isSubagent: false,
      sessionId: "session_1",
      toolNames: [],
    });
    const firstStored = structuredClone(
      await messageManager.listBySession("session_1"),
    );

    version = 2;
    const reused = await manager.prepareTurn({
      directory: "/repo-v2",
      modelId: "model-a",
      promptSnapshot: firstSnapshot,
      sessionId: "session_1",
    });
    const reusedAgain = await manager.prepareTurn({
      directory: "/repo-v3",
      modelId: "model-a",
      promptSnapshot: firstSnapshot,
      sessionId: "session_1",
    });
    expect(reused.request).toEqual(reusedAgain.request);
    expect(JSON.stringify(reused.request)).toContain("stable-system-1");
    expect(JSON.stringify(reused.request)).toContain("memory-1");
    expect(JSON.stringify(reused.request)).toContain("runtime-1");
    expect(JSON.stringify(reused.request)).not.toContain("runtime-2");

    const secondUser = await messageManager.createMessage({
      agent: "build",
      id: "user_turn_2",
      role: "user",
      sessionId: "session_1",
    });
    await messageManager.appendPart(secondUser.id, {
      text: "second request",
      type: "text",
    });
    const secondSnapshot = await manager.createRunPromptSnapshot({
      directory: "/repo-v2",
      initiatingUserMessageId: secondUser.id,
      isSubagent: false,
      sessionId: "session_1",
      toolNames: [],
    });
    const next = await manager.prepareTurn({
      directory: "/repo-v2",
      modelId: "model-a",
      promptSnapshot: secondSnapshot,
      sessionId: "session_1",
    });
    const afterSecondTurn = await messageManager.listBySession("session_1");

    expect(afterSecondTurn[0]).toEqual(firstStored[0]);
    expect(JSON.stringify(next.request)).toContain("stable-system-2");
    expect(JSON.stringify(next.request)).toContain("memory-2");
    expect(JSON.stringify(next.request)).toContain("runtime-1");
    expect(JSON.stringify(next.request)).toContain("runtime-2");
    expect(afterSecondTurn[1]?.parts.filter(isModelContextPart)).toHaveLength(
      1,
    );
  });

  it("creates isolated primary and subagent snapshots concurrently on one shared manager", async () => {
    const messageManager = createMessageManagerFixture();
    const primaryUser = await messageManager.createMessage({
      agent: "build",
      id: "primary_user",
      role: "user",
      sessionId: "parent_session",
    });
    await messageManager.appendPart(primaryUser.id, {
      text: "primary request",
      type: "text",
    });
    const childUser = await messageManager.createMessage({
      agent: "explore",
      contextScopeId: "subagent_1",
      id: "child_user",
      role: "user",
      sessionId: "child_session",
    });
    await messageManager.appendPart(childUser.id, {
      text: "child request",
      type: "text",
    });
    const { manager } = createManager({
      memory: {
        load: () =>
          Promise.resolve({
            global: "primary-memory",
            merged: "primary-memory",
            project: "",
          }),
      },
      messageManager,
      systemPromptProvider: {
        build: (input) =>
          Promise.resolve(
            `stable-${input.contextScopeId ?? "primary"}-${input.directory}`,
          ),
        buildRuntimeContext: (input) =>
          Promise.resolve(
            `<environment_context>${input.contextScopeId ?? "primary"}-${input.directory}</environment_context>`,
          ),
      },
    });
    const [primarySnapshot, childSnapshot] = await Promise.all([
      manager.createRunPromptSnapshot({
        directory: "/primary",
        initiatingUserMessageId: primaryUser.id,
        isSubagent: false,
        sessionId: "parent_session",
        toolNames: [],
      }),
      manager.createRunPromptSnapshot({
        agentName: "explore",
        contextScopeId: "subagent_1",
        directory: "/child",
        initiatingUserMessageId: childUser.id,
        isSubagent: true,
        sessionId: "child_session",
        toolNames: [],
      }),
    ]);
    const [primary, child] = await Promise.all([
      manager.prepareTurn({
        directory: "/primary",
        modelId: "model-a",
        promptSnapshot: primarySnapshot,
        sessionId: "parent_session",
      }),
      manager.prepareTurn({
        agentName: "explore",
        contextScopeId: "subagent_1",
        directory: "/child",
        isSubagent: true,
        modelId: "model-a",
        promptSnapshot: childSnapshot,
        sessionId: "child_session",
      }),
    ]);
    const primaryWire = JSON.stringify(primary.request);
    const childWire = JSON.stringify(child.request);

    expect(primaryWire).toContain("stable-primary-/primary");
    expect(primaryWire).toContain("primary-memory");
    expect(primaryWire).toContain("primary-/primary");
    expect(primaryWire).not.toContain("child request");
    expect(childWire).toContain("stable-subagent_1-/child");
    expect(childWire).toContain("subagent_1-/child");
    expect(childWire).not.toContain("primary-memory");
    expect(childWire).not.toContain("primary request");
  });

  it("compacts a request containing runtime context without duplicating it as a tail directive", async () => {
    const messageManager = createMessageManagerFixture();
    for (const [role, text] of [
      ["user", "old user ".repeat(20)],
      ["assistant", "old assistant ".repeat(20)],
      ["user", "middle user ".repeat(20)],
      ["assistant", "middle assistant ".repeat(20)],
    ] as const) {
      await addTextMessage(messageManager, {
        role,
        sessionId: "session_1",
        text,
      });
    }
    const currentUser = await messageManager.createMessage({
      agent: "build",
      id: "current_user",
      role: "user",
      sessionId: "session_1",
    });
    await messageManager.appendPart(currentUser.id, {
      text: "current request",
      type: "text",
    });
    const marker = "runtime-compaction-marker";
    const { manager, measurements } = createManager({
      llmClient: {
        generateSummary: vi.fn().mockResolvedValue("## Goal\nshort summary"),
      },
      memory: {
        load: vi
          .fn()
          .mockResolvedValue({ global: "", merged: "", project: "" }),
      },
      messageManager,
      systemPromptProvider: {
        build: vi.fn().mockResolvedValue("stable"),
        buildRuntimeContext: vi.fn().mockResolvedValue(marker),
      },
      tokenCounter: {
        estimateTokens: (content) => content.length,
        getLimit: () => 10_000,
      },
    });
    const promptSnapshot = await manager.createRunPromptSnapshot({
      directory: "/repo",
      initiatingUserMessageId: currentUser.id,
      isSubagent: false,
      sessionId: "session_1",
      toolNames: [],
    });
    const prepared = await manager.prepareTurn({
      directory: "/repo",
      force: true,
      modelId: "model-a",
      promptSnapshot,
      sessionId: "session_1",
    });
    const markerCount = (value: unknown): number =>
      JSON.stringify(value).split(marker).length - 1;

    expect(prepared.compaction?.status).toBe("compacted");
    expect(measurements.some((request) => markerCount(request) === 1)).toBe(
      true,
    );
    expect(measurements.every((request) => markerCount(request) <= 1)).toBe(
      true,
    );
    expect(markerCount(prepared.request)).toBeLessThanOrEqual(1);
    expect(
      (await messageManager.listBySession("session_1"))
        .flatMap((message) => message.parts)
        .filter(isModelContextPart),
    ).toHaveLength(1);
  });

  it("counts assistant tool calls even when message content is null", () => {
    const messages = [
      {
        content: null,
        role: "assistant" as const,
        tool_calls: [
          {
            function: {
              arguments: '{"path":"/a/very/long/path/with/many/chars.ts"}',
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

  it("prepares only messages in the requested context scope", async () => {
    const messageManager = createMessageManagerFixture();
    const scopedA = await messageManager.createMessage({
      agent: "explore",
      contextScopeId: "subagent_a",
      role: "user",
      sessionId: "child_1",
    });
    await messageManager.appendPart(scopedA.id, {
      text: "A question",
      type: "text",
    });
    const scopedB = await messageManager.createMessage({
      agent: "research",
      contextScopeId: "subagent_b",
      role: "user",
      sessionId: "child_1",
    });
    await messageManager.appendPart(scopedB.id, {
      text: "B question",
      type: "text",
    });
    const { manager } = createManager({ messageManager });

    const prepared = await manager.prepareTurn({
      contextScopeId: "subagent_a",
      directory: "/repo",
      isSubagent: true,
      modelId: "fake-model",
      sessionId: "child_1",
    });

    expect(JSON.stringify(prepared.request.messages)).toContain("A question");
    expect(JSON.stringify(prepared.request.messages)).not.toContain(
      "B question",
    );
  });

  it("keeps subagent calibration isolated by context scope", async () => {
    const messageManager = createMessageManagerFixture();
    for (const contextScopeId of ["subagent_a", "subagent_b"]) {
      const message = await messageManager.createMessage({
        agent: "explore",
        contextScopeId,
        role: "user",
        sessionId: "child_1",
      });
      await messageManager.appendPart(message.id, {
        text: "same scoped question",
        type: "text",
      });
    }
    const { manager } = createManager({
      messageManager,
      tokenCounter: {
        estimateTokens: (content: string) => content.length,
        getLimit: () => 100_000,
      },
    });
    const prepareScope = (
      contextScopeId: string,
    ): ReturnType<ContextManager["prepareTurn"]> =>
      manager.prepareTurn({
        agentName: "explore",
        contextScopeId,
        directory: "/repo",
        isSubagent: true,
        modelId: "fake-model",
        sessionId: "child_1",
      });
    const [baselineA, baselineB] = await Promise.all([
      prepareScope("subagent_a"),
      prepareScope("subagent_b"),
    ]);

    manager.updateCalibrationFactor(
      "child_1",
      baselineA.sentHeuristic * 2,
      baselineA.sentHeuristic,
      "subagent_a",
    );
    const [calibratedA, unchangedB] = await Promise.all([
      prepareScope("subagent_a"),
      prepareScope("subagent_b"),
    ]);

    expect(calibratedA.usage.currentTokens).toBe(
      Math.round(calibratedA.sentHeuristic * 1.5),
    );
    expect(unchangedB.usage.currentTokens).toBe(unchangedB.sentHeuristic);
    expect(baselineA.sentHeuristic).toBe(baselineB.sentHeuristic);

    manager.disposeScope("child_1", "subagent_a");
    const [resetA, stillUnchangedB] = await Promise.all([
      prepareScope("subagent_a"),
      prepareScope("subagent_b"),
    ]);
    expect(resetA.usage.currentTokens).toBe(resetA.sentHeuristic);
    expect(stillUnchangedB.usage.currentTokens).toBe(
      stillUnchangedB.sentHeuristic,
    );
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

    const context = await manager.assemble("session_1", "D:/repo", {
      isSubagent: false,
      toolNames: [],
    });

    expect(context.systemPrompt).toBe("system prompt");
    expect(context.memory.merged).toContain("global memory");
    expect(context.history).toHaveLength(1);
    expect(context.hasSummary).toBe(false);
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
    const context = await manager.assemble("session_1", "D:/repo", {
      isSubagent: false,
      toolNames: [],
    });
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

    const onCompactionStarted = vi.fn();
    const prepared = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      onCompactionStarted,
      sessionId: "session_1",
    });

    expect(prepared.request.messages[0].role).toBe("system");
    expect(prepared.request.messages[0].content).toEqual(
      expect.stringContaining("system prompt"),
    );
    expect(prepared.compaction).toBeUndefined();
    expect(prepared.hasSummary).toBe(false);
    expect(prepared.sentHeuristic).toBeGreaterThan(0);
    expect(onCompactionStarted).not.toHaveBeenCalled();
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

  it("moves calibration toward repeated observations without jumping directly to them", async () => {
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

    for (let index = 0; index < 4; index += 1) {
      manager.updateCalibrationFactor(
        "session_1",
        baseline.sentHeuristic * 2,
        baseline.sentHeuristic,
      );
    }
    const calibrated = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });

    expect(calibrated.usage.currentTokens).toBe(
      Math.round(calibrated.sentHeuristic * 1.9375),
    );
  });

  it("clamps calibration observations before applying EMA", async () => {
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
      baseline.sentHeuristic * 10,
      baseline.sentHeuristic,
    );
    const highClamped = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });
    manager.updateCalibrationFactor(
      "session_1",
      baseline.sentHeuristic * 0.1,
      baseline.sentHeuristic,
    );
    const lowClamped = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });

    expect(highClamped.usage.currentTokens).toBe(
      Math.round(highClamped.sentHeuristic * 2),
    );
    expect(lowClamped.usage.currentTokens).toBe(
      Math.round(lowClamped.sentHeuristic * 1.25),
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

    expect(prepared.request.messages).toContainEqual({
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

    expect(prepared.request.messages).toContainEqual({
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
    expect(prepared.request.messages).toContainEqual({
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
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValue("<state_snapshot>short</state_snapshot>");
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

    const onCompactionStarted = vi.fn();
    const prepared = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      onCompactionStarted,
      sessionId: "session_1",
    });

    expect(prepared.compaction).toBeUndefined();
    expect(prepared.usage.usageRatio).toBeLessThan(0.5);
    expect(onCompactionStarted).not.toHaveBeenCalled();
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it("stops after prune when usage no longer needs prune-summary", async () => {
    const messageManager = createMessageManagerFixture();
    await addCompletedToolMessage(messageManager, {
      sessionId: "session_1",
      output: "old tool output ".repeat(800),
    });
    for (const [index, role] of ["user", "assistant", "user"].entries()) {
      await addTextMessage(messageManager, {
        sessionId: "session_1",
        role: role as "user" | "assistant",
        text: `${String(index)} ${"recent text ".repeat(300)}`,
      });
    }
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValue("<state_snapshot>short</state_snapshot>");
    const commitCompaction = vi.spyOn(messageManager, "commitCompaction");
    const onCompactionStarted = vi.fn();
    const tokenCounter = {
      estimateTokens: (content: string): number => content.length,
      getBudget(
        _modelId: string,
        options?: Parameters<NonNullable<TokenCounter["getBudget"]>>[1],
      ): ReturnType<NonNullable<TokenCounter["getBudget"]>> {
        const usedInputTokens = options?.usedInputTokens ?? 0;
        const inputBudgetTokens = 20_000;
        return {
          contextWindowTokens: 24_000,
          inputBudgetTokens,
          maxOutputTokens: 2_000,
          modelId: "model-a",
          remainingInputTokens: Math.max(
            0,
            inputBudgetTokens - usedInputTokens,
          ),
          reservedOutputTokens: 2_000,
          safetyMarginTokens: 2_000,
          usageRatio: usedInputTokens / inputBudgetTokens,
          usedInputTokens,
        };
      },
      getLimit: (): number => 24_000,
    } satisfies TokenCounter;
    const tools = [
      {
        function: {
          name: "read_file",
          parameters: { type: "object" },
        },
        type: "function" as const,
      },
    ];
    const { manager } = createManager({
      compressionThreshold: 0.8,
      llmClient: { generateSummary },
      messageManager,
      pruneMinimumTokens: 1,
      pruneProtectTokens: 0,
      tokenCounter,
    });

    const prepared = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      onCompactionStarted,
      sessionId: "session_1",
      tools,
    });

    expect(prepared.compaction?.status).toBe("pruned");
    expect(prepared.usage.usageRatio).toBeGreaterThanOrEqual(0.5);
    expect(prepared.usage.usageRatio).toBeLessThan(0.8);
    expect(prepared.sentHeuristic).toBe(
      estimateWireHeuristic(
        prepared.request.messages,
        tokenCounter,
        prepared.request.tools,
      ),
    );
    expect(prepared.sentHeuristic).toBeGreaterThan(
      estimateWireHeuristic(prepared.request.messages, tokenCounter),
    );
    expect(onCompactionStarted).toHaveBeenCalledTimes(1);
    expect(commitCompaction).toHaveBeenCalled();
    expect(onCompactionStarted.mock.invocationCallOrder[0]).toBeLessThan(
      commitCompaction.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(generateSummary).not.toHaveBeenCalled();
  });

  it("reduces prune-summary attempts across a ten-step tool-output loop when mask is enabled", async () => {
    function isMaskedEvent(event: unknown): event is {
      readonly enabled: true;
      readonly maskedPartIds: readonly string[];
    } {
      if (typeof event !== "object" || event === null) {
        return false;
      }
      const candidate = event as {
        readonly enabled?: unknown;
        readonly maskedPartIds?: unknown;
      };
      return (
        candidate.enabled === true &&
        Array.isArray(candidate.maskedPartIds) &&
        candidate.maskedPartIds.every((partId) => typeof partId === "string")
      );
    }

    async function runToolLoop(maskEnabled: boolean): Promise<{
      readonly compactionStatus?: string;
      readonly masked: readonly unknown[];
      readonly summaryCalls: number;
    }> {
      const messageManager = createMessageManagerFixture();
      for (let index = 0; index < 10; index += 1) {
        await addCompletedToolMessage(messageManager, {
          sessionId: "session_1",
          output: `tool ${String(index)} output ${"x".repeat(2_000)}`,
        });
      }
      await addTextMessage(messageManager, {
        sessionId: "session_1",
        role: "user",
        text: "continue from the latest result",
      });
      const generateSummary = vi
        .fn<ContextLLMClient["generateSummary"]>()
        .mockResolvedValue("<state_snapshot>short</state_snapshot>");
      const { manager, masked } = createManager({
        compressionThreshold: 0.8,
        llmClient: { generateSummary },
        maskConfig: {
          minPartTokens: 1,
          minPrunableTokens: 1,
          minUsageRatio: 0.5,
          protectionTokens: 1,
        },
        maskEnabled,
        messageManager,
        pruneMinimumTokens: 1,
        pruneProtectTokens: 100_000,
        tokenCounter: {
          estimateTokens: (content: string) => content.length,
          getBudget(_modelId, options) {
            const usedInputTokens = options?.usedInputTokens ?? 0;
            const inputBudgetTokens = 20_000;
            return {
              contextWindowTokens: 24_000,
              inputBudgetTokens,
              maxOutputTokens: 2_000,
              modelId: "model-a",
              remainingInputTokens: Math.max(
                0,
                inputBudgetTokens - usedInputTokens,
              ),
              reservedOutputTokens: 2_000,
              safetyMarginTokens: 2_000,
              usageRatio: usedInputTokens / inputBudgetTokens,
              usedInputTokens,
            };
          },
          getLimit: () => 24_000,
        },
      });

      const prepared = await manager.prepareTurn({
        directory: "D:/repo",
        modelId: "model-a",
        sessionId: "session_1",
      });

      return {
        compactionStatus: prepared.compaction?.status,
        masked,
        summaryCalls: generateSummary.mock.calls.length,
      };
    }

    const withoutMask = await runToolLoop(false);
    const withMask = await runToolLoop(true);
    const maskedEvent = withMask.masked.find(isMaskedEvent);

    expect(withoutMask.summaryCalls).toBe(1);
    expect(withoutMask.compactionStatus).toBe("compacted");
    expect(withMask.summaryCalls).toBe(0);
    expect(withMask.compactionStatus).toBeUndefined();
    expect(maskedEvent?.maskedPartIds).toContain("part_1");
  });

  it("reuses unchanged projection measurements on the mask-off no-compaction path", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "small prompt",
    });
    let wireEstimateCalls = 0;
    const { manager } = createManager({
      compressionThreshold: 10,
      maskEnabled: false,
      messageManager,
      tokenCounter: {
        estimateTokens(content: string): number {
          if (content.startsWith("{")) {
            wireEstimateCalls += 1;
          }
          return content.length;
        },
        getLimit: () => 100_000,
      },
    });

    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });

    expect(wireEstimateCalls).toBe(2);
  });

  it("rechecks durable history before compaction commit without reloading memory", async () => {
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
    const { manager, measurements } = createManager({
      llmClient: {
        generateSummary: vi.fn().mockResolvedValue("## Goal\nshort"),
      },
      memory,
      messageManager,
    });

    const onCompactionStarted = vi.fn();
    const tailDirective = { content: "tail-r02", role: "system" as const };
    const tools = [
      {
        function: {
          name: "read_file",
          parameters: { type: "object" },
        },
        type: "function" as const,
      },
    ];
    const prepared = await manager.prepareTurn({
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
      onCompactionStarted,
      sessionId: "session_1",
      tailDirectives: [tailDirective],
      toolNames: ["read_file"],
      tools,
    });

    expect(prepared.compaction?.status).toBe("compacted");
    expect(measurements.length).toBeGreaterThan(2);
    expect(measurements.at(-1)).toEqual(prepared.request);
    for (const measurement of measurements) {
      expect(measurement.tools).toEqual(tools);
      expect(
        measurement.messages.filter(
          (message) => message.content === tailDirective.content,
        ),
      ).toHaveLength(1);
    }
    expect(listBySession).toHaveBeenCalledTimes(3);
    expect(loadMemory).toHaveBeenCalledTimes(1);
    expect(onCompactionStarted).toHaveBeenCalledTimes(1);
  });

  it("starts ordinary automatic compaction before generating its summary", async () => {
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
        text: `${String(index)} ${"long text ".repeat(30)}`,
      });
    }
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValue("## Goal\nshort");
    const onCompactionStarted = vi.fn();
    const { manager } = createManager({
      compressionThreshold: 0.5,
      llmClient: { generateSummary },
      messageManager,
    });

    const prepared = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      onCompactionStarted,
      sessionId: "session_1",
    });

    expect(prepared.compaction?.status).toBe("compacted");
    expect(onCompactionStarted).toHaveBeenCalledTimes(1);
    expect(generateSummary).toHaveBeenCalledTimes(1);
    expect(onCompactionStarted.mock.invocationCallOrder[0]).toBeLessThan(
      generateSummary.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
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
      manager.assemble("session_1", "D:/repo", {
        isSubagent: false,
        toolNames: [],
      }),
    ).resolves.toMatchObject({
      memory: { global: "", project: "", merged: "" },
    });

    const subagentContext = await manager.assemble("session_1", "D:/repo", {
      isSubagent: true,
      toolNames: [],
    });
    expect(subagentContext.memory).toEqual({
      global: "",
      project: "",
      merged: "",
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("calculates fallback usage against the full context limit", () => {
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
    const usage = getContextUsage(45, "model-a", {
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
    });

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
    const usage = getContextUsage(96_500, "large-model", {
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
    });

    expect(usage.usageRatio).toBeLessThan(0.97);
    expect(usage.remainingTokens).toBe(3_500);
    expect(
      decideCompactionRung({
        force: false,
        usage,
      }),
    ).toBe("prune-summary");
  });

  it("uses the 95 percent threshold and a strict 4096-token remaining floor", () => {
    const usage = (
      usageRatio: number,
      remainingTokens: number,
    ): ReturnType<typeof getContextUsage> => ({
      contextLimit: 100_000,
      currentTokens: 100_000 - remainingTokens,
      inputBudgetTokens: 100_000,
      modelId: "large-model",
      remainingTokens,
      usageRatio,
    });

    expect(COMPRESSION_THRESHOLD).toBe(0.95);
    expect(COMPACTION_MIN_REMAINING_INPUT_TOKENS).toBe(4_096);
    expect(
      decideCompactionRung({
        force: false,
        usage: usage(0.95, 5_000),
      }),
    ).toBe("prune-summary");
    expect(
      decideCompactionRung({
        force: false,
        usage: usage(0.94, 4_096),
      }),
    ).toBe("mask");
    expect(
      decideCompactionRung({
        force: false,
        usage: usage(0.94, 4_095),
      }),
    ).toBe("prune-summary");
  });

  it("uses the unified compaction ladder thresholds", () => {
    expect(
      decideCompactionRung({
        force: false,
        usage: {
          contextLimit: 100_000,
          currentTokens: 40_000,
          inputBudgetTokens: 100_000,
          modelId: "large-model",
          remainingTokens: 60_000,
          usageRatio: 0.4,
        },
      }),
    ).toBe("none");
    expect(
      decideCompactionRung({
        force: false,
        usage: {
          contextLimit: 100_000,
          currentTokens: 70_000,
          inputBudgetTokens: 100_000,
          modelId: "large-model",
          remainingTokens: 30_000,
          usageRatio: 0.7,
        },
      }),
    ).toBe("mask");
    expect(
      decideCompactionRung({
        force: false,
        usage: {
          contextLimit: 100_000,
          currentTokens: 90_000,
          inputBudgetTokens: 100_000,
          modelId: "large-model",
          remainingTokens: 10_000,
          usageRatio: 0.9,
        },
      }),
    ).toBe("mask");
    expect(
      decideCompactionRung({
        force: false,
        thrashLocked: true,
        usage: {
          contextLimit: 100_000,
          currentTokens: 98_000,
          inputBudgetTokens: 100_000,
          modelId: "large-model",
          remainingTokens: 2_000,
          usageRatio: 0.98,
        },
      }),
    ).toBe("none");
    expect(
      decideCompactionRung({
        force: true,
        thrashLocked: true,
        usage: {
          contextLimit: 100_000,
          currentTokens: 98_000,
          inputBudgetTokens: 100_000,
          modelId: "large-model",
          remainingTokens: 2_000,
          usageRatio: 0.98,
        },
      }),
    ).toBe("force");
    expect(
      decideCompactionRung({
        compactionCount: 2,
        force: false,
        maxPerTurn: 2,
        usage: {
          contextLimit: 100_000,
          currentTokens: 98_000,
          inputBudgetTokens: 100_000,
          modelId: "large-model",
          remainingTokens: 2_000,
          usageRatio: 0.98,
        },
      }),
    ).toBe("mask");
    expect(
      decideCompactionRung({
        compactionCount: 2,
        force: true,
        maxPerTurn: 2,
        usage: {
          contextLimit: 100_000,
          currentTokens: 98_000,
          inputBudgetTokens: 100_000,
          modelId: "large-model",
          remainingTokens: 2_000,
          usageRatio: 0.98,
        },
      }),
    ).toBe("force");
    expect(
      decideCompactionRung({
        compactionCount: 2,
        force: true,
        maxPerTurn: 0,
        thrashLocked: true,
        usage: {
          contextLimit: 100_000,
          currentTokens: 98_000,
          inputBudgetTokens: 100_000,
          modelId: "large-model",
          remainingTokens: 2_000,
          usageRatio: 0.98,
        },
      }),
    ).toBe("force");
    expect(
      decideCompactionRung({
        force: false,
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

  it("publishes turn-prepared usage and compaction status", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "small",
    });
    const { manager, turnPrepared } = createManager({
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

    expect(turnPrepared).toMatchObject([
      {
        sessionId: "session_1",
        triggeredCompaction: false,
        usage: prepared.usage,
      },
    ]);
  });

  it("keeps the same tool schemas in manual compact measurements", async () => {
    const messageManager = createMessageManagerFixture();
    for (const [index, role] of ["user", "assistant", "user"].entries()) {
      await addTextMessage(messageManager, {
        role: role as "user" | "assistant",
        sessionId: "session_1",
        text: `${String(index)} ${"long context ".repeat(40)}`,
      });
    }
    const estimateTokens = vi.fn((content: string) => content.length);
    const { manager } = createManager({
      messageManager,
      tokenCounter: {
        estimateTokens,
        getLimit: () => 100_000,
      },
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
    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
      toolNames: ["read_file"],
      tools,
    });

    const schemaMeasurements = estimateTokens.mock.calls.filter(([content]) =>
      content.includes('"name":"read_file"'),
    );
    expect(result.status).toBe("compacted");
    expect(result.usageAfter.currentTokens).toBeLessThan(
      result.usageBefore.currentTokens,
    );
    expect(schemaMeasurements).toHaveLength(4);
    expect(
      schemaMeasurements.every(([content]) =>
        content.endsWith(JSON.stringify(tools)),
      ),
    ).toBe(true);
  });

  it("keeps forced manual and automatic compaction on the same model view and usage scale", async () => {
    async function createSeededFixture(): Promise<{
      readonly manager: FixtureContextManager;
    }> {
      const messageManager = createMessageManagerFixture();
      for (const [index, role] of ["user", "assistant", "user"].entries()) {
        await addTextMessage(messageManager, {
          role: role as "user" | "assistant",
          sessionId: "session_1",
          text: `${String(index)} ${"same context ".repeat(40)}`,
        });
      }
      return createManager({
        messageManager,
        tokenCounter: {
          estimateTokens: (content) => content.length,
          getLimit: () => 100_000,
        },
      });
    }

    const tools = [
      {
        function: {
          name: "read_file",
          parameters: { type: "object" },
        },
        type: "function" as const,
      },
    ];
    const manual = await createSeededFixture();
    const automatic = await createSeededFixture();
    const compacted = await manual.manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
      toolNames: ["read_file"],
      tools,
    });
    const manualPrepared = await manual.manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
      toolNames: ["read_file"],
      tools,
    });
    const automaticPrepared = await automatic.manager.prepareTurn({
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
      sessionId: "session_1",
      toolNames: ["read_file"],
      tools,
    });

    expect(compacted.status).toBe("compacted");
    expect(automaticPrepared.compaction?.status).toBe("compacted");
    expect(manualPrepared.request).toEqual(automaticPrepared.request);
    expect(manualPrepared.usage).toEqual(automaticPrepared.usage);
    expect(compacted.usageAfter).toEqual(manualPrepared.usage);
    expect(automaticPrepared.compaction?.usageAfter).toEqual(
      automaticPrepared.usage,
    );
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
    expect(result.compression).toMatchObject({
      status: "compressed",
      summaryMessageId: "message_5",
    });
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
      manager.assemble("session_1", "D:/repo", {
        isSubagent: false,
        toolNames: [],
      }),
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
    const context = await manager.assemble("session_1", "D:/repo", {
      isSubagent: false,
      toolNames: [],
    });
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
    expect(result.compression).toMatchObject({
      status: "compressed",
      summaryMessageId: "message_5",
    });
    const context = await manager.assemble("session_1", "D:/repo", {
      isSubagent: false,
      toolNames: [],
    });
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
    const activeHistory = (
      await manager.assemble("session_1", "D:/repo", {
        isSubagent: false,
        toolNames: [],
      })
    ).history;
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

  it("shrinks summary overflow by complete oldest rounds before retrying", async () => {
    const messageManager = createMessageManagerFixture();
    await addSummaryOverflowHistory(messageManager, 8, "child_1");
    const overflow = Object.assign(new Error("context length exceeded"), {
      code: "context_length_exceeded",
    });
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockRejectedValueOnce(overflow)
      .mockRejectedValueOnce(overflow)
      .mockResolvedValueOnce("## Goal\nshort");
    const { compactionProgress, manager } = createManager({
      llmClient: { generateSummary },
      messageManager,
      pruneMinimumTokens: Number.MAX_SAFE_INTEGER,
    });

    const result = await manager.compact("session_1", {
      contextScopeId: "child_1",
      directory: "D:/repo",
      force: true,
      isSubagent: true,
      modelId: "model-a",
    });

    expect(result.status).toBe("compacted");
    expect(generateSummary).toHaveBeenCalledTimes(3);
    const histories = generateSummary.mock.calls.map(
      ([input]) => input.history,
    );
    expect(histories.map((history) => history.length)).toEqual(
      histories.map((history) => history.length).sort((a, b) => b - a),
    );
    expect(histories[1]?.length).toBeLessThan(histories[0]?.length ?? 0);
    expect(histories[2]?.length).toBeLessThan(histories[1]?.length ?? 0);
    for (const history of histories.slice(1)) {
      expect(history[0]?.info.role).toBe("user");
      const messages = serializeForLlm({
        history,
        isSubagent: true,
        memory: { global: "", merged: "", project: "" },
        systemPrompt: "",
      });
      for (const [index, message] of messages.entries()) {
        if (message.role !== "tool") {
          continue;
        }
        const previous = messages[index - 1];
        expect(previous.role).toBe("assistant");
        expect(
          "tool_calls" in previous
            ? previous.tool_calls?.some(
                (call) => call.id === message.tool_call_id,
              )
            : false,
        ).toBe(true);
      }
    }
    expect(compactionProgress).toMatchObject([
      {
        attempt: 1,
        contextScopeId: "child_1",
        droppedRounds: 0,
        sessionId: "session_1",
      },
      {
        attempt: 2,
        contextScopeId: "child_1",
        droppedRounds: 1,
        sessionId: "session_1",
      },
      {
        attempt: 3,
        contextScopeId: "child_1",
        droppedRounds: 1,
        sessionId: "session_1",
      },
    ]);
  });

  it("bounds repeated summary overflow and leaves original history active", async () => {
    const messageManager = createMessageManagerFixture();
    await addSummaryOverflowHistory(messageManager, 10);
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockRejectedValue(
        Object.assign(new Error("maximum context length"), {
          code: "context_length_exceeded",
        }),
      );
    const { manager } = createManager({
      llmClient: { generateSummary },
      messageManager,
      pruneMinimumTokens: Number.MAX_SAFE_INTEGER,
    });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });

    expect(result).toMatchObject({
      compression: {
        reason: "summary-overflow-exhausted",
        status: "failed",
      },
      status: "failed",
    });
    expect(generateSummary).toHaveBeenCalledTimes(4);
    expect(await summaryMessageCount(messageManager, "session_1")).toBe(0);
    expect(
      (await messageManager.listBySession("session_1")).every((message) =>
        message.parts.every((part) => part.time?.compacted === undefined),
      ),
    ).toBe(true);
  });

  it("does not retry non-overflow summary failures", async () => {
    const messageManager = createMessageManagerFixture();
    await addSummaryOverflowHistory(messageManager, 8);
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockRejectedValue(new Error("provider unavailable"));
    const { manager } = createManager({
      llmClient: { generateSummary },
      messageManager,
      pruneMinimumTokens: Number.MAX_SAFE_INTEGER,
    });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });

    expect(result).toMatchObject({
      compression: { status: "failed" },
      status: "failed",
    });
    expect(generateSummary).toHaveBeenCalledTimes(1);
  });

  it("stops shrinking when only the most recent user round remains", async () => {
    const messageManager = createMessageManagerFixture();
    await addSummaryOverflowHistory(messageManager, 3);
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockRejectedValue(
        Object.assign(new Error("context window exceeded"), {
          code: "context_length_exceeded",
        }),
      );
    const { manager } = createManager({
      llmClient: { generateSummary },
      messageManager,
      pruneMinimumTokens: Number.MAX_SAFE_INTEGER,
    });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });

    expect(result).toMatchObject({
      compression: {
        reason: "summary-overflow-minimum",
        status: "failed",
      },
      status: "failed",
    });
    expect(generateSummary.mock.calls.length).toBeLessThan(4);
  });

  it("stops immediately when summary generation is aborted", async () => {
    const messageManager = createMessageManagerFixture();
    await addSummaryOverflowHistory(messageManager, 8);
    const abortError = new Error("cancelled");
    abortError.name = "AbortError";
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockRejectedValue(abortError);
    const { compactionFinished, manager } = createManager({
      llmClient: { generateSummary },
      messageManager,
      pruneMinimumTokens: Number.MAX_SAFE_INTEGER,
    });

    await expect(
      manager.compact("session_1", {
        directory: "D:/repo",
        force: true,
        modelId: "model-a",
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(generateSummary).toHaveBeenCalledTimes(1);
    expect(compactionFinished).toMatchObject([
      { outcome: "aborted", sessionId: "session_1", status: "failed" },
    ]);
  });

  it("locks automatic compaction after repeated zero-savings summary attempts", async () => {
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
        text: `${String(index)} ${"long text ".repeat(20)}`,
      });
    }
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValue("x".repeat(10_000));
    const { compactSkipped, manager } = createManager({
      compressionThreshold: 0.5,
      llmClient: { generateSummary },
      maxCompactionsPerTurn: 10,
      messageManager,
    });

    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });
    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });
    expect(generateSummary).toHaveBeenCalledTimes(4);

    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });

    expect(generateSummary).toHaveBeenCalledTimes(4);
    expect(compactSkipped.at(-1)).toMatchObject({
      reason: "thrash-locked",
      sessionId: "session_1",
    });

    await manager.prepareTurn({
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
      sessionId: "session_1",
    });
    expect(generateSummary).toHaveBeenCalledTimes(6);

    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "new large input ".repeat(100),
    });
    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });
    expect(generateSummary).toHaveBeenCalledTimes(8);
  });

  it("disposes per-session calibration and compaction state", async () => {
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
        text: `${String(index)} ${"long text ".repeat(20)}`,
      });
    }
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValue("x".repeat(10_000));
    const { manager } = createManager({
      compressionThreshold: 0.5,
      llmClient: { generateSummary },
      maxCompactionsPerTurn: 10,
      messageManager,
    });
    manager.updateCalibrationFactor("session_1", 300, 100);
    const context = await manager.assemble("session_1", "D:/repo", {
      isSubagent: false,
      toolNames: [],
    });
    const calibratedUsage = manager.getUsage({
      context,
      modelId: "model-a",
      tools: undefined,
    });

    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });
    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });
    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });
    expect(generateSummary).toHaveBeenCalledTimes(4);

    manager.disposeSession("session_1");
    const resetUsage = manager.getUsage({
      context,
      modelId: "model-a",
      tools: undefined,
    });
    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });

    expect(resetUsage.currentTokens).toBeLessThan(
      calibratedUsage.currentTokens,
    );
    expect(generateSummary).toHaveBeenCalledTimes(6);
  });

  it("counts forced prepareTurn compactions but not manual compact calls", async () => {
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
        text: `${String(index)} ${"long text ".repeat(20)}`,
      });
    }
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValue("x".repeat(10_000));
    const { compactSkipped, manager } = createManager({
      compressionThreshold: 0.5,
      llmClient: { generateSummary },
      maxCompactionsPerTurn: 1,
      messageManager,
      thrashWindow: 0,
    });

    await manager.prepareTurn({
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
      sessionId: "session_1",
    });
    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });
    expect(generateSummary).toHaveBeenCalledTimes(2);
    expect(compactSkipped.at(-1)).toMatchObject({
      reason: "per-turn-cap",
      sessionId: "session_1",
    });

    manager.resetTurnCompactionCount("session_1");
    await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });
    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });
    expect(generateSummary).toHaveBeenCalledTimes(6);
  });

  it("caps automatic prune-summary attempts per turn", async () => {
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
        text: `${String(index)} ${"long text ".repeat(20)}`,
      });
    }
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValue("x".repeat(10_000));
    const { compactSkipped, manager } = createManager({
      compressionThreshold: 0.5,
      llmClient: { generateSummary },
      maxCompactionsPerTurn: 2,
      messageManager,
      thrashWindow: 0,
    });

    manager.resetTurnCompactionCount("session_1");
    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });
    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });
    expect(generateSummary).toHaveBeenCalledTimes(4);

    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });

    expect(generateSummary).toHaveBeenCalledTimes(4);
    expect(compactSkipped.at(-1)).toMatchObject({
      reason: "per-turn-cap",
      sessionId: "session_1",
    });

    manager.resetTurnCompactionCount("session_1");
    await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
    });
    expect(generateSummary).toHaveBeenCalledTimes(6);
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
      .find(isContextSummaryPart);
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
      .find(isContextSummaryPart);
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
