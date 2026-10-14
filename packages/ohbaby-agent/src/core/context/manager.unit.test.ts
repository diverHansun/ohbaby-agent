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
  MemoryReader,
  PreparedModelRequest,
  PrepareTurnInput,
  SystemPromptProvider,
  TokenCounter,
} from "./types.js";
import { isActivePart } from "./filters.js";
import { serializeForLlm } from "./serializer.js";
import { isSummaryMessage, partitionSummary } from "./summary.js";
import { estimatePreparedRequestHeuristic } from "./token-estimation.js";
import { createHeuristicTokenCounter } from "../../services/llm-model/tokenCounting.js";

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
  readonly measurements: readonly PreparedModelRequest[];
  readonly memory: MemoryReader;
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
      return 128_000;
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
    readonly systemPromptProvider?: SystemPromptProvider;
  } = {},
): ContextFixture {
  const bus = createBus();
  const compactionFinished: unknown[] = [];
  const compactionProgress: unknown[] = [];
  const compactSkipped: unknown[] = [];
  const compressed: unknown[] = [];
  const measurements: PreparedModelRequest[] = [];
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
        generateSummary: vi.fn().mockResolvedValue({
          text: "<state_snapshot>short</state_snapshot>",
          summaryMessageId: "summary",
          requests: [],
        }),
      } satisfies ContextLLMClient),
    now: options.now ?? createClock(),
    onRequestMeasured: (request) => measurements.push(request),
    compressionThreshold: options.compressionThreshold,
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
  bus.subscribe(ContextEvent.TurnPrepared, (payload) => {
    turnPrepared.push(payload);
  });

  return {
    compactionFinished,
    compactionProgress,
    compactSkipped,
    compressed,
    manager,
    measurements,
    memory,
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
      text: `user-${String(index)} ${"request ".repeat(400)}`,
      ...(contextScopeId === undefined ? {} : { contextScopeId }),
    });
    await addCompletedToolMessage(messageManager, {
      output: `tool-${String(index)} ${"result ".repeat(400)}`,
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
    const tools = [{ name: "read_file", inputSchema: { type: "object" } }];
    const toolDefinitions = [
      {
        category: "readonly" as const,
        description: "Read a file",
        name: "read_file",
        parameters: { type: "object" },
        source: "builtin" as const,
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
    const withToolDefinitions = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
      toolDefinitions,
      toolNames: ["read_file"],
      tools,
    });

    expect(withTools.request.messages).toEqual(messagesOnly.request.messages);
    expect(withTools.request.tools).toEqual(tools);
    expect(Object.isFrozen(withTools.request)).toBe(true);
    expect(Object.isFrozen(withTools.request.messages)).toBe(true);
    expect(Object.isFrozen(withTools.request.tools)).toBe(true);
    expect(Object.isFrozen(withTools.request.tools?.[0]?.inputSchema)).toBe(
      true,
    );
    expect(Object.isFrozen(tools[0]?.inputSchema)).toBe(false);
    expect(() => {
      (withTools.request.tools?.[0].inputSchema as { type?: string }).type =
        "array";
    }).toThrow();
    expect(withTools.sentHeuristic).toBeGreaterThan(messagesOnly.sentHeuristic);
    expect(withTools.usage.currentTokens).toBeGreaterThan(
      messagesOnly.usage.currentTokens,
    );
    expect(withTools.composition).toBeUndefined();
    expect(withToolDefinitions.request).toEqual(withTools.request);
    expect(withToolDefinitions.composition?.["builtin-tools"]).toBeGreaterThan(
      0,
    );
    expect(withToolDefinitions.composition?.conversation).toBeGreaterThan(0);

    manager.updateCalibrationFactor(
      "session_1",
      withTools.sentHeuristic * 2,
      withTools.sentHeuristic,
    );
    const calibrated = await manager.prepareTurn({
      directory: "D:/repo",
      modelId: "model-a",
      sessionId: "session_1",
      toolDefinitions,
      toolNames: ["read_file"],
      tools,
    });
    expect(calibrated.usage.currentTokens).toBe(
      Math.round(calibrated.sentHeuristic * 1.5),
    );
    expect(calibrated.composition).toEqual(withToolDefinitions.composition);
    const compositionTokens = Object.values(
      calibrated.composition ?? {},
    ) as number[];
    expect(
      compositionTokens.reduce((total, tokens) => total + tokens, 0),
    ).not.toBe(calibrated.usage.currentTokens);
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
      estimatePreparedRequestHeuristic(prepared.request, tokenCounter),
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
    const firstBuilding = deferred<undefined>();
    const releaseBuild = deferred<undefined>();
    let builders = 0;
    const { manager } = createManager({
      messageManager,
      systemPromptProvider: {
        build: () => Promise.resolve("stable"),
        buildRuntimeContext: async () => {
          builders += 1;
          firstBuilding.resolve(undefined);
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
    await firstBuilding.promise;
    const second = manager.createRunPromptSnapshot(input);
    await Promise.resolve();
    expect(builders).toBe(1);
    releaseBuild.resolve(undefined);
    await Promise.all([first, second]);

    const runtimeParts = (await messageManager.listBySession("session_1"))
      .flatMap((message) => message.parts)
      .filter(isModelContextPart);
    expect(builders).toBe(1);
    expect(runtimeParts).toHaveLength(1);
  });

  it("serializes runtime attachment with prepareTurn in the same scope", async () => {
    const messageManager = createMessageManagerFixture();
    const user = await messageManager.createMessage({
      agent: "build",
      id: "lane_user",
      role: "user",
      sessionId: "session_1",
    });
    await messageManager.appendPart(user.id, {
      text: "serialize runtime",
      type: "text",
    });
    const runtimeBuilding = deferred<undefined>();
    const releaseRuntime = deferred<undefined>();
    const listBySession = vi.spyOn(messageManager, "listBySession");
    const { manager } = createManager({
      messageManager,
      systemPromptProvider: {
        build: () => Promise.resolve("stable"),
        buildRuntimeContext: async () => {
          runtimeBuilding.resolve(undefined);
          await releaseRuntime.promise;
          return "runtime";
        },
      },
    });

    const snapshot = manager.createRunPromptSnapshot({
      directory: "/repo",
      initiatingUserMessageId: user.id,
      isSubagent: false,
      sessionId: "session_1",
      toolNames: [],
    });
    await runtimeBuilding.promise;
    expect(listBySession).toHaveBeenCalledTimes(1);

    const prepared = manager.prepareTurn({
      directory: "/repo",
      modelId: "model-a",
      promptSnapshot: {
        memory: { global: "", merged: "", project: "" },
        systemPrompt: "stable",
      },
      sessionId: "session_1",
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(listBySession).toHaveBeenCalledTimes(1);

    releaseRuntime.resolve(undefined);
    await snapshot;
    await prepared;
    expect(listBySession).toHaveBeenCalledTimes(2);
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
    const oldConversationMarker = "OLD_CONVERSATION_MUST_BE_COMPACTED";
    const oldSubagentMarker = "OLD_SUBAGENT_MUST_BE_COMPACTED";
    const oldSubagent = await messageManager.createMessage({
      agent: "build",
      role: "assistant",
      sessionId: "session_1",
    });
    await messageManager.appendPart(oldSubagent.id, {
      callId: "call_old_subagent",
      state: {
        input: { prompt: oldSubagentMarker },
        output: oldSubagentMarker,
        status: "completed",
      },
      tool: "subagent_run",
      type: "tool",
    });
    for (const [role, text] of [
      ["user", `${oldConversationMarker} ${"old user ".repeat(800)}`],
      ["assistant", "old assistant ".repeat(800)],
      ["user", "middle user ".repeat(800)],
      ["assistant", "middle assistant ".repeat(800)],
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
        generateSummary: vi.fn().mockResolvedValue({
          text: "## Goal\nshort summary",
          summaryMessageId: "summary",
          requests: [],
        }),
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
        getLimit: () => 128_000,
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
    expect(prepared.composition?.["summarized-conversation"]).toBeGreaterThan(
      0,
    );
    expect(prepared.composition?.["system-prompt"]).toBeGreaterThan(0);
    expect(prepared.composition?.["subagent-exchanges"]).toBe(0);
    expect(JSON.stringify(prepared.request)).not.toContain(
      oldConversationMarker,
    );
    expect(JSON.stringify(prepared.request)).not.toContain(oldSubagentMarker);
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

  it("keeps a complete assistant group without pulling in the preceding user", () => {
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
    expect(cut.keptMessages).toEqual([currentAssistant]);
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
    manager.updateCalibrationFactor(
      "child_1",
      baselineB.sentHeuristic * 3,
      baselineB.sentHeuristic,
      "subagent_b",
    );
    const [calibratedA, calibratedB] = await Promise.all([
      prepareScope("subagent_a"),
      prepareScope("subagent_b"),
    ]);

    expect(calibratedA.usage.currentTokens).toBe(
      Math.round(calibratedA.sentHeuristic * 1.5),
    );
    expect(calibratedB.usage.currentTokens).toBe(
      Math.round(calibratedB.sentHeuristic * 2),
    );
    expect(baselineA.sentHeuristic).toBe(baselineB.sentHeuristic);

    manager.disposeScope("child_1", "subagent_a");
    const [resetA, retainedB] = await Promise.all([
      prepareScope("subagent_a"),
      prepareScope("subagent_b"),
    ]);
    expect(resetA.usage.currentTokens).toBe(resetA.sentHeuristic);
    expect(retainedB.usage.currentTokens).toBe(
      Math.round(retainedB.sentHeuristic * 2),
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
        toolCalls: [
          {
            callId: "call_read",
            name: "read_file",
            argumentsJson: '{"path":"README.md"}',
          },
        ],
      },
      { role: "tool", callId: "call_read", content: "content" },
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
        toolCalls: [
          {
            callId: "call_read",
            name: "read",
            argumentsJson: '{"file_path":"README.md"}',
          },
        ],
      },
      {
        role: "tool",
        callId: "call_read",
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
      callId: "call_bash",
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
      callId: "call_mcp",
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
      callId: "call_bash",
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

  it("isolates calibration and disposal across sessions", async () => {
    const messageManager = createMessageManagerFixture();
    for (const sessionId of ["session_a", "session_b"]) {
      await addTextMessage(messageManager, {
        sessionId,
        role: "user",
        text: "identical content",
      });
    }
    const { manager } = createManager({ messageManager });
    const prepareSession = (
      sessionId: string,
    ): ReturnType<ContextManager["prepareTurn"]> =>
      manager.prepareTurn({
        directory: "D:/repo",
        modelId: "model-a",
        sessionId,
      });
    const [baselineA, baselineB] = await Promise.all([
      prepareSession("session_a"),
      prepareSession("session_b"),
    ]);

    manager.updateCalibrationFactor(
      "session_a",
      baselineA.sentHeuristic * 2,
      baselineA.sentHeuristic,
    );
    manager.updateCalibrationFactor(
      "session_b",
      baselineB.sentHeuristic * 3,
      baselineB.sentHeuristic,
    );
    const [calibratedA, calibratedB] = await Promise.all([
      prepareSession("session_a"),
      prepareSession("session_b"),
    ]);
    expect(calibratedA.sentHeuristic).toBe(calibratedB.sentHeuristic);
    expect(calibratedA.usage.currentTokens).toBe(
      Math.round(calibratedA.sentHeuristic * 1.5),
    );
    expect(calibratedB.usage.currentTokens).toBe(
      Math.round(calibratedB.sentHeuristic * 2),
    );

    manager.disposeSession("session_a");
    const [resetA, retainedB] = await Promise.all([
      prepareSession("session_a"),
      prepareSession("session_b"),
    ]);
    expect(resetA.usage.currentTokens).toBe(resetA.sentHeuristic);
    expect(retainedB.usage.currentTokens).toBe(
      Math.round(retainedB.sentHeuristic * 2),
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

  it.each([
    { actual: 100, sent: 0 },
    { actual: 100, sent: -1 },
    { actual: 100, sent: Number.NaN },
    { actual: 100, sent: Number.POSITIVE_INFINITY },
    { actual: Number.NaN, sent: 10 },
    { actual: Number.POSITIVE_INFINITY, sent: 10 },
  ])(
    "ignores invalid calibration sample actual=$actual sent=$sent",
    async ({ actual, sent }) => {
      const messageManager = createMessageManagerFixture();
      await addTextMessage(messageManager, {
        sessionId: "session_invalid_calibration",
        role: "user",
        text: "hello",
      });
      const { manager } = createManager({ messageManager });
      const baseline = await manager.prepareTurn({
        directory: "D:/repo",
        modelId: "model-a",
        sessionId: "session_invalid_calibration",
      });

      manager.updateCalibrationFactor(
        "session_invalid_calibration",
        actual,
        sent,
      );
      const unchanged = await manager.prepareTurn({
        directory: "D:/repo",
        modelId: "model-a",
        sessionId: "session_invalid_calibration",
      });

      expect(unchanged.sentHeuristic).toBe(baseline.sentHeuristic);
      expect(unchanged.usage.currentTokens).toBe(baseline.sentHeuristic);
    },
  );

  it("preserves complete tool results and their call pairing in prepared requests", async () => {
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
    const { manager } = createManager({
      compressionThreshold: 10,
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
      callId: "message_1_call",
    });
    expect(prepared.request.messages).toContainEqual({
      content: null,
      role: "assistant",
      toolCalls: [
        { callId: "message_1_call", argumentsJson: "{}", name: "read_file" },
      ],
    });
  });

  it("reuses request measurements and estimates final composition once on the unchanged path", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "small prompt",
    });
    let wireEstimateCalls = 0;
    const { manager } = createManager({
      compressionThreshold: 10,
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

    expect(wireEstimateCalls).toBe(5);
  });

  it("commits expected part snapshots without reloading memory", async () => {
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
      text: "first long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "second long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "third long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "fourth long text".repeat(1000),
    });
    const { manager, measurements } = createManager({
      llmClient: {
        generateSummary: vi.fn().mockResolvedValue({
          text: "## Goal\nshort",
          summaryMessageId: "summary",
          requests: [],
        }),
      },
      memory,
      messageManager,
    });

    const onCompactionStarted = vi.fn();
    const tailDirective = { content: "tail-r02", role: "system" as const };
    const tools = [{ name: "read_file", inputSchema: { type: "object" } }];
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
        text: `${String(index)} ${"long text ".repeat(800)}`,
      });
    }
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValue({
        text: "## Goal\nshort",
        summaryMessageId: "summary",
        requests: [],
      });
    const onCompactionStarted = vi.fn();
    const { manager } = createManager({
      compressionThreshold: 0.02,
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

  it("retains input-budget accounting separately from the full context window", () => {
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

  it("does not auto summarize before 90 percent of the full window when input budget is almost exhausted", () => {
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
    ).toBe("none");
  });

  it.each([89_999, 90_000, 90_001])(
    "uses full-window occupancy at the 90 percent boundary: %i",
    (currentTokens) => {
      expect(COMPRESSION_THRESHOLD).toBe(0.9);
      expect(
        decideCompactionRung({
          force: false,
          usage: {
            contextLimit: 100_000,
            currentTokens,
            inputBudgetTokens: 90_000,
            modelId: "large-model",
            remainingTokens: 0,
            usageRatio: currentTokens / 90_000,
          },
        }),
      ).toBe(currentTokens < 90_000 ? "none" : "summary");
    },
  );

  it("leaves history unchanged below summary pressure", () => {
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
    ).toBe("none");
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
    ).toBe("summary");

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
    ).toBe("summary");
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
        text: `${String(index)} ${"long context ".repeat(600)}`,
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
    const tools = [{ name: "read_file", inputSchema: { type: "object" } }];
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
    expect(schemaMeasurements.length).toBeGreaterThanOrEqual(4);
    expect(
      schemaMeasurements.every(([content]) =>
        content.endsWith(
          '[{"name":"read_file","inputSchema":{"type":"object"}}]',
        ),
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
          text: `${String(index)} ${"same context ".repeat(600)}`,
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

    const tools = [{ name: "read_file", inputSchema: { type: "object" } }];
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

  it("compresses older history into a synthetic summary message", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "first long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "second long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "third long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "fourth long text".repeat(1000),
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
      summaryMessageId:
        result.compression?.status === "compressed"
          ? result.compression.summaryMessageId
          : "",
    });
    expect(result.compression?.savedTokens).toBeGreaterThan(0);
    const history = await messageManager.listBySession("session_1");
    const compactedAt = history[0]?.parts[0]?.time?.compacted;
    expect(compactedAt).toBeDefined();
    expect(history[1]?.parts[0]?.time?.compacted).toBe(compactedAt);
    expect(history[2]?.parts[0]?.time?.compacted).toBe(compactedAt);
    expect(history[3]?.parts[0]?.time?.compacted).toBeUndefined();
    expect(history.at(-1)).toMatchObject({
      info: {
        id:
          result.compression?.status === "compressed"
            ? result.compression.summaryMessageId
            : "",
        role: "assistant",
      },
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
      history: [
        {
          info: {
            id:
              result.compression?.status === "compressed"
                ? result.compression.summaryMessageId
                : "",
          },
        },
        { info: { id: "message_4" } },
      ],
    });
    expect(compressed).toHaveLength(1);
  });

  it("compacts by summarizing older history and re-injecting the summary into assembled context", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "first long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "second long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "third long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "fourth long text".repeat(1000),
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
      summaryMessageId:
        result.compression?.status === "compressed"
          ? result.compression.summaryMessageId
          : "",
    });
    const context = await manager.assemble("session_1", "D:/repo", {
      isSubagent: false,
      toolNames: [],
    });
    expect(context.hasSummary).toBe(true);
    expect(context.history).toMatchObject([
      {
        info: {
          id:
            result.compression?.status === "compressed"
              ? result.compression.summaryMessageId
              : "",
          role: "assistant",
        },
        parts: [{ text: "<state_snapshot>short</state_snapshot>" }],
      },
      { info: { id: "message_4", role: "assistant" } },
    ]);
  });

  it("summarizes complete active history without a preceding prune", async () => {
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
      text: "first long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "second long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "third long text".repeat(1000),
    });
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValue({
        text: "## Goal\nshort",
        summaryMessageId: "summary",
        requests: [],
      });
    const { manager } = createManager({
      llmClient: { generateSummary },
      memory,
      messageManager,
    });

    const result = await manager.compact("session_1", {
      directory: "D:/repo",
      force: true,
      modelId: "model-a",
    });

    expect(result.status).toBe("compacted");
    const summaryInput = generateSummary.mock.calls[0][0];
    expect(JSON.stringify(summaryInput.request.messages)).toContain(
      "old-pruned.txt",
    );
    const summaryPart = (await messageManager.listBySession("session_1")).at(-1)
      ?.parts[0];
    const summary = summaryPart?.type === "text" ? summaryPart.text : "";
    expect(summary).toContain("old-pruned.txt");
    expect(summary).toContain("<read-files>");
  });

  it("retains token usage metadata after compaction because estimation no longer consumes it", async () => {
    const messageManager = createMessageManagerFixture();
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "first long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "second long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "third long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "fourth long text".repeat(1000),
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
        generateSummary: vi.fn().mockResolvedValue({
          text: "## Goal\nshort",
          summaryMessageId: "summary",
          requests: [],
        }),
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
        text: `${String(index)} ${"x".repeat(index === 3 ? 20000 : 80)}`,
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
        Promise.resolve({
          text: "s".repeat(1000),
          summaryMessageId: input.summaryMessageId,
          requests: [],
        }),
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

  it("appends the summary instruction while preserving the normal system prompt", async () => {
    const messageManager = createMessageManagerFixture();
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValue({
        text: "## Goal\nshort",
        summaryMessageId: "summary",
        requests: [],
      });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "first long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "second long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "third long text".repeat(1000),
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
    expect(summaryInput.request.messages.at(-1)?.content).toContain("## Goal");
    expect(summaryInput.request.messages[0].content).toContain("system prompt");
  });

  it("does not redo an inflated summary with another prompt", async () => {
    const messageManager = createMessageManagerFixture();
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockResolvedValueOnce({
        text: "x".repeat(2000),
        summaryMessageId: "summary",
        requests: [],
      })
      .mockResolvedValueOnce({
        text: "short",
        summaryMessageId: "summary",
        requests: [],
      });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "small one".repeat(200),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "small two".repeat(500),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "small three".repeat(1300),
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

    expect(result.status).toBe("inflated");
    expect(result.compression?.status).toBe("inflated");
    expect(generateSummary).toHaveBeenCalledTimes(1);
  });

  it("fails after the shared overflow allowance and preserves scoped history", async () => {
    const messageManager = createMessageManagerFixture();
    await addSummaryOverflowHistory(messageManager, 8, "child_1");
    const original = await messageManager.listBySession("session_1");
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockRejectedValueOnce(
        Object.assign(new Error("context length exceeded"), {
          code: "context_length_exceeded",
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("context length exceeded"), {
          code: "context_length_exceeded",
        }),
      );
    const { compactionProgress, manager } = createManager({
      llmClient: { generateSummary },
      messageManager,
    });
    const result = await manager.compact("session_1", {
      contextScopeId: "child_1",
      directory: "D:/repo",
      force: true,
      isSubagent: true,
      modelId: "model-a",
    });
    expect(result).toMatchObject({
      status: "failed",
      compression: {
        status: "failed",
        error: "context length exceeded",
      },
    });
    expect(generateSummary).toHaveBeenCalledTimes(2);
    expect(compactionProgress.slice(0, 1)).toMatchObject([
      {
        attempt: 1,
        contextScopeId: "child_1",
        sessionId: "session_1",
      },
    ]);
    expect(await messageManager.listBySession("session_1")).toEqual(original);
    expect(await summaryMessageCount(messageManager, "session_1")).toBe(0);
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

  it("does not commit a summary when cancellation wins after generation", async () => {
    const messageManager = createMessageManagerFixture();
    await addSummaryOverflowHistory(messageManager, 8);
    const controller = new AbortController();
    const generateSummary = vi
      .fn<ContextLLMClient["generateSummary"]>()
      .mockImplementation(() => {
        controller.abort(new DOMException("cancelled", "AbortError"));
        return Promise.resolve({
          text: "short summary",
          summaryMessageId: "summary",
          requests: [],
        });
      });
    const { manager } = createManager({
      llmClient: { generateSummary },
      messageManager,
    });

    await expect(
      manager.prepareTurn({
        directory: "D:/repo",
        force: true,
        modelId: "model-a",
        sessionId: "session_1",
        signal: controller.signal,
        toolNames: [],
        tools: undefined,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      summaryMessageCount(messageManager, "session_1"),
    ).resolves.toBe(0);
  });

  it.each([8000, 10000])(
    "rejects summary capacity before sending with %i ordinary output",
    async (output) => {
      const messageManager = createMessageManagerFixture();
      for (const role of ["user", "assistant", "user", "assistant"] as const)
        await addTextMessage(messageManager, {
          sessionId: "session_1",
          role,
          text: "x".repeat(30000),
        });
      const counter = createHeuristicTokenCounter({
        defaultLimit: 10000,
        defaultMaxOutputTokens: output,
      });
      const generateSummary = vi.fn<ContextLLMClient["generateSummary"]>();
      const { manager } = createManager({
        messageManager,
        tokenCounter: counter,
        llmClient: { generateSummary },
      });
      const result = await manager.prepareTurn({
        sessionId: "session_1",
        directory: "/repo",
        modelId: "custom",
      });
      expect(result.compaction?.status).toBe("failed");
      expect(generateSummary).not.toHaveBeenCalled();
      expect(
        (await messageManager.listBySession("session_1"))
          .flatMap((m) => m.parts)
          .every((p) => p.time?.compacted === undefined),
      ).toBe(true);
    },
  );

  it("disposes per-session calibration", async () => {
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
      .mockResolvedValue({
        text: "x".repeat(10_000),
        summaryMessageId: "summary",
        requests: [],
      });
    const { manager } = createManager({
      compressionThreshold: 0.02,
      llmClient: { generateSummary },
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

    manager.disposeSession("session_1");
    const resetUsage = manager.getUsage({
      context,
      modelId: "model-a",
      tools: undefined,
    });
    expect(resetUsage.currentTokens).toBeLessThan(
      calibratedUsage.currentTokens,
    );
  });

  it("includes file operations from the complete active history", async () => {
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
      text: "middle long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "recent long text".repeat(1000),
    });
    const { manager } = createManager({
      llmClient: {
        generateSummary: vi.fn().mockResolvedValue({
          text: "## Goal\nshort",
          summaryMessageId: "summary",
          requests: [],
        }),
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

    expect(summaryText).toContain("src/a.ts");
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
      text: "first active long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "assistant",
      text: "second active long text".repeat(1000),
    });
    await addTextMessage(messageManager, {
      sessionId: "session_1",
      role: "user",
      text: "third active long text".repeat(1000),
    });
    const { manager } = createManager({
      llmClient: {
        generateSummary: vi.fn().mockResolvedValue({
          text: "## Goal\nshort",
          summaryMessageId: "summary",
          requests: [],
        }),
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
    const generateSummary = vi.fn().mockResolvedValue({
      text: "<state_snapshot>short</state_snapshot>",
      summaryMessageId: "summary",
      requests: [],
    });
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
      text: "first long text".repeat(1000),
    });
    await addTextMessage(failingMessageManager, {
      sessionId: "session_fail",
      role: "assistant",
      text: "second long text".repeat(1000),
    });
    await addTextMessage(failingMessageManager, {
      sessionId: "session_fail",
      role: "user",
      text: "third long text".repeat(1000),
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
      text: "small one".repeat(200),
    });
    await addTextMessage(inflatedMessageManager, {
      sessionId: "session_inflated",
      role: "assistant",
      text: "small two".repeat(500),
    });
    await addTextMessage(inflatedMessageManager, {
      sessionId: "session_inflated",
      role: "user",
      text: "small three".repeat(1300),
    });
    const inflated = createManager({
      llmClient: {
        generateSummary: vi.fn().mockResolvedValue({
          text: "x".repeat(2000),
          summaryMessageId: "summary",
          requests: [],
        }),
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
});
