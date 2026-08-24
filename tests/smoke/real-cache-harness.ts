import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createBus } from "../../packages/ohbaby-agent/src/bus/index.js";
import { toOpenAiTools } from "../../packages/ohbaby-agent/src/core/agents/index.js";
import {
  createContextManager,
  type ContextLLMClient,
  type MemoryReader,
  type SystemPromptProvider,
  type TokenCounter,
} from "../../packages/ohbaby-agent/src/core/context/index.js";
import { Lifecycle } from "../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import type {
  LifecycleEvent,
  LifecycleResult,
} from "../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import {
  createLLMClient,
  type LLMClientInstance,
  type TokenUsage,
} from "../../packages/ohbaby-agent/src/core/llm-client/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  readTokenUsageMetadata,
  type MessageWithParts,
} from "../../packages/ohbaby-agent/src/core/message/index.js";
import {
  admitMcpTools,
  createSelectToolsTool,
  McpClient,
  McpManager,
  McpToolMenu,
  ScopeToolSequence,
  type McpTransport,
} from "../../packages/ohbaby-agent/src/mcp/index.js";
import { createPermissionState } from "../../packages/ohbaby-agent/src/permission/index.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../../packages/ohbaby-agent/src/services/interface-providers/index.js";
import {
  createToolScheduler,
  type Tool,
  type ToolExecutionEnvironment,
} from "../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";

const CACHE_FIXTURE_READ = "cache_fixture_read";
const CACHE_FIXTURE_SELECT = "select_tools";
const CACHE_FIXTURE_MCP = "mcp_s5_cache_t6_lookup";
const FORCE_FIXTURE_TOOL_MARKER = "OHBABY_FORCE_CACHE_FIXTURE_TOOL";
const STABLE_SYSTEM_PROMPT = [
  "You are the deterministic ohbaby prompt-cache verification agent.",
  ...Array.from(
    { length: 160 },
    (_, index) =>
      `Stable cache fixture rule ${String(index + 1).padStart(3, "0")}: preserve the ordered system, tool schemas, and prior messages; follow the latest user suffix exactly.`,
  ),
].join("\n");

export function assertCacheableStablePrefix(minimumTokens: number): number {
  const stablePromptTokens = Math.ceil(STABLE_SYSTEM_PROMPT.length / 4);
  if (stablePromptTokens < minimumTokens) {
    throw new Error(
      `Stable cache prefix estimates ${String(stablePromptTokens)} tokens, below the configured minimum ${String(minimumTokens)}.`,
    );
  }
  return stablePromptTokens;
}

export interface RealCacheProviderProfile {
  readonly apiKeyEnv: string;
  readonly baseUrl: string;
  readonly interfaceProvider: "anthropic" | "openai-compatible";
  readonly minimumCacheableTokens: number;
  readonly model: string;
  readonly provider: string;
}

function minimumCacheableTokens(variableName: string): number {
  const raw = process.env[variableName]?.trim();
  if (raw === undefined || raw === "") {
    return 4_096;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${variableName} must be a positive integer.`);
  }
  return value;
}

export interface SanitizedRequestProjection {
  readonly cacheKeyFingerprint?: string;
  readonly cacheKeyPresent: boolean;
  readonly contextScopeId?: string;
  readonly messageDigests: readonly string[];
  readonly promptCacheStrategy: string;
  readonly sessionId?: string;
  readonly toolDigests: readonly string[];
  readonly toolEpoch: number;
  readonly toolNames: readonly string[];
}

export interface TurnEvidence {
  readonly events: readonly LifecycleEvent[];
  readonly projections: readonly SanitizedRequestProjection[];
  readonly result: LifecycleResult;
  readonly usages: readonly TokenUsage[];
}

function requireModel(variableName: string): string {
  const value = process.env[variableName]?.trim();
  if (!value) {
    throw new Error(
      `${variableName} is required when its real-cache credential is present.`,
    );
  }
  return value;
}

export function resolveOpenAiCompatibleProfile(): RealCacheProviderProfile {
  const model = requireModel("OHBABY_REAL_CACHE_OPENAI_MODEL");
  if (process.env.OPENAI_API_KEY?.trim()) {
    return {
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1",
      interfaceProvider: "openai-compatible",
      minimumCacheableTokens: minimumCacheableTokens(
        "OHBABY_REAL_CACHE_OPENAI_MIN_TOKENS",
      ),
      model,
      provider: "openai",
    };
  }
  if (process.env.DEEPSEEK_API_KEY?.trim()) {
    return {
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseUrl: "https://api.deepseek.com",
      interfaceProvider: "openai-compatible",
      minimumCacheableTokens: minimumCacheableTokens(
        "OHBABY_REAL_CACHE_OPENAI_MIN_TOKENS",
      ),
      model,
      provider: "deepseek",
    };
  }
  if (process.env.ZAI_API_KEY?.trim() || process.env.ZHIPU_API_KEY?.trim()) {
    return {
      apiKeyEnv: process.env.ZAI_API_KEY?.trim()
        ? "ZAI_API_KEY"
        : "ZHIPU_API_KEY",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      interfaceProvider: "openai-compatible",
      minimumCacheableTokens: minimumCacheableTokens(
        "OHBABY_REAL_CACHE_OPENAI_MIN_TOKENS",
      ),
      model,
      provider: "zhipu",
    };
  }
  throw new Error("No OpenAI-compatible real-cache credential is available.");
}

export function resolveAnthropicProfile(): RealCacheProviderProfile {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error("No Anthropic real-cache credential is available.");
  }
  return {
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com",
    interfaceProvider: "anthropic",
    minimumCacheableTokens: minimumCacheableTokens(
      "OHBABY_REAL_CACHE_ANTHROPIC_MIN_TOKENS",
    ),
    model: requireModel("OHBABY_REAL_CACHE_ANTHROPIC_MODEL"),
    provider: "anthropic",
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex")
    .slice(0, 16);
}

function scopeKey(sessionId: string, contextScopeId?: string): string {
  return `${sessionId}\u0000${contextScopeId ?? ""}`;
}

function createEnvironment(workdir: string): ToolExecutionEnvironment {
  return {
    workdir,
    resolveCommandContext(): { readonly cwd: string; readonly kind: string } {
      return { cwd: workdir, kind: "host-local" };
    },
    resolvePath(inputPath: string): string {
      return join(workdir, inputPath);
    },
    resolvePathForExisting(inputPath: string): Promise<string> {
      return Promise.resolve(join(workdir, inputPath));
    },
    resolvePathForWrite(inputPath: string): Promise<string> {
      return Promise.resolve(join(workdir, inputPath));
    },
  };
}

function createTokenCounter(): TokenCounter {
  return {
    estimateTokens(content: string): number {
      return Math.ceil(content.length / 4);
    },
    getLimit(): number {
      return 200_000;
    },
  };
}

function createSystemPromptProvider(): SystemPromptProvider {
  return {
    build: () => Promise.resolve(STABLE_SYSTEM_PROMPT),
    buildRuntimeContext: (input) =>
      Promise.resolve(
        `<environment_context><cwd>${input.directory}</cwd><cache_smoke>true</cache_smoke></environment_context>`,
      ),
  };
}

function createEmptyMemory(): MemoryReader {
  return {
    load: () => Promise.resolve({ global: "", merged: "", project: "" }),
  };
}

function createSummaryClient(): ContextLLMClient {
  return {
    generateSummary: () =>
      Promise.resolve(
        "<state_snapshot>real cache smoke summary</state_snapshot>",
      ),
  };
}

function installFixtureToolChoice(
  interfaceProvider: RealCacheProviderProfile["interfaceProvider"],
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : request
          ? await request.clone().text()
          : undefined;
    if (!bodyText?.includes(FORCE_FIXTURE_TOOL_MARKER)) {
      return originalFetch(input, init);
    }

    const body = JSON.parse(bodyText) as Record<string, unknown>;
    const serializedMessages = JSON.stringify(body.messages);
    const alreadyHasToolResult =
      serializedMessages.includes('"role":"tool"') ||
      serializedMessages.includes('"type":"tool_result"');
    if (alreadyHasToolResult) {
      return originalFetch(input, init);
    }

    body.tool_choice =
      interfaceProvider === "anthropic"
        ? { name: CACHE_FIXTURE_READ, type: "tool" }
        : {
            function: { name: CACHE_FIXTURE_READ },
            type: "function",
          };
    const nextInit = { ...init, body: JSON.stringify(body) };
    if (request) {
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      return originalFetch(
        new Request(request, {
          body: nextInit.body,
          headers,
          signal: init?.signal ?? request.signal,
        }),
      );
    }
    return originalFetch(input, nextInit);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

export function projectRequest(
  request: InterfaceProviderRequest,
  toolEpoch: number,
): SanitizedRequestProjection {
  const cacheKey = request.promptCache.key;
  return {
    ...(cacheKey === undefined
      ? {}
      : { cacheKeyFingerprint: digest(cacheKey) }),
    cacheKeyPresent: cacheKey !== undefined,
    ...(request.contextScopeId === undefined
      ? {}
      : { contextScopeId: request.contextScopeId }),
    messageDigests: request.messages.map(digest),
    promptCacheStrategy: request.promptCache.strategy,
    ...(request.sessionId === undefined
      ? {}
      : { sessionId: request.sessionId }),
    toolDigests: (request.tools ?? []).map(digest),
    toolEpoch,
    toolNames: (request.tools ?? []).map((tool) => tool.function.name),
  };
}

function wrapClientWithProjectionRecorder(
  client: LLMClientInstance,
  projections: SanitizedRequestProjection[],
  currentEpoch: (request: InterfaceProviderRequest) => number,
): LLMClientInstance {
  const stream = client.provider.streamChatCompletion.bind(client.provider);
  return {
    ...client,
    provider: {
      ...client.provider,
      streamChatCompletion(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        projections.push(projectRequest(request, currentEpoch(request)));
        return stream(request);
      },
    },
  };
}

export function assertAppendExtension(
  left: SanitizedRequestProjection,
  right: SanitizedRequestProjection,
): void {
  if (left.toolEpoch !== right.toolEpoch) {
    throw new Error("request projections do not belong to the same tool epoch");
  }
  if (JSON.stringify(left.toolDigests) !== JSON.stringify(right.toolDigests)) {
    throw new Error("ordered tool projection changed inside one cache epoch");
  }
  const prefix = right.messageDigests.slice(0, left.messageDigests.length);
  if (JSON.stringify(prefix) !== JSON.stringify(left.messageDigests)) {
    throw new Error("message projection is not an append-extension");
  }
  if (left.cacheKeyFingerprint !== right.cacheKeyFingerprint) {
    throw new Error("scoped prompt-cache identity changed inside one scope");
  }
  if (
    left.cacheKeyPresent !== right.cacheKeyPresent ||
    left.promptCacheStrategy !== right.promptCacheStrategy
  ) {
    throw new Error("prompt-cache request strategy changed inside one scope");
  }
}

export function cacheReadUsages(usages: readonly TokenUsage[]): TokenUsage[] {
  return usages.filter((usage) => (usage.inputBreakdown?.cacheRead ?? 0) > 0);
}

export function cacheWriteOrReadUsages(
  usages: readonly TokenUsage[],
): TokenUsage[] {
  return usages.filter(
    (usage) =>
      (usage.inputBreakdown?.cacheWrite ?? 0) > 0 ||
      (usage.inputBreakdown?.cacheRead ?? 0) > 0,
  );
}

export interface RealCacheHarness {
  readonly evidencePath: string;
  readonly fixtureExecutions: () => number;
  readonly projections: readonly SanitizedRequestProjection[];
  activateMcpTool(sessionId: string, contextScopeId?: string): Promise<void>;
  close(): Promise<void>;
  metadataUsages(
    sessionId: string,
    contextScopeId?: string,
  ): Promise<readonly TokenUsage[]>;
  runTurn(input: {
    readonly contextScopeId?: string;
    readonly isSubagent?: boolean;
    readonly maxSteps?: number;
    readonly prompt: string;
    readonly sessionId: string;
  }): Promise<TurnEvidence>;
}

export async function createRealCacheHarness(
  profile: RealCacheProviderProfile,
): Promise<RealCacheHarness> {
  const stablePromptTokens = assertCacheableStablePrefix(
    profile.minimumCacheableTokens,
  );
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-real-cache-"));
  const workdir = join(directory, "workspace");
  const modelJsonPath = join(directory, "model.json");
  const evidenceDirectory =
    process.env.OHBABY_REAL_CACHE_EVIDENCE_DIR?.trim() ||
    join(tmpdir(), "ohbaby-real-cache-evidence");
  const evidencePath = join(
    evidenceDirectory,
    `${profile.provider}-${randomUUID()}.json`,
  );
  await mkdir(evidenceDirectory, { recursive: true });
  await mkdir(workdir, { recursive: true });
  await writeFile(
    modelJsonPath,
    JSON.stringify({
      apiConfig: {
        apiKeyEnv: profile.apiKeyEnv,
        baseUrl: profile.baseUrl,
        interfaceProvider: profile.interfaceProvider,
        promptCache: "auto",
      },
      defaultModel: profile.model,
      llmParams: {
        contextWindowTokens: 200_000,
        maxTokens: 256,
        temperature: 0,
      },
      provider: profile.provider,
    }),
    "utf8",
  );

  const bus = createBus();
  const messageManager = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
  });
  const scheduler = createToolScheduler({
    bus,
    permission: { ask: () => "once" },
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
  });
  const [mcpClientTransport, mcpServerTransport] =
    InMemoryTransport.createLinkedPair();
  const mcpServer = new McpServer({
    name: "ohbaby-real-cache-fixture",
    version: "1.0.0",
  });
  mcpServer.registerTool(
    "lookup",
    {
      annotations: { readOnlyHint: true },
      description: "Look up the deterministic cache smoke catalog.",
      inputSchema: {},
    },
    () => ({ content: [{ text: "OHBABY_REAL_CACHE_MCP_OK", type: "text" }] }),
  );
  await mcpServer.connect(mcpServerTransport);
  let mcpTransportClaimed = false;
  const mcpManager = new McpManager(`${workdir}#real-cache`, {
    createClient: (name, config) =>
      new McpClient(name, config, {
        createTransport: (): McpTransport => {
          if (mcpTransportClaimed) {
            throw new Error("real-cache MCP transport was requested twice");
          }
          mcpTransportClaimed = true;
          return mcpClientTransport;
        },
      }),
    loadConfig: () =>
      Promise.resolve({
        mcpServers: {
          cache: {
            args: [],
            command: "in-memory-real-cache-fixture",
            enabled: true,
            timeout: 5_000,
            trust: true,
            type: "stdio" as const,
          },
        },
      }),
  });
  let fixtureExecutionCount = 0;
  const menu = new McpToolMenu();
  const fixtureTools: Tool[] = [
    {
      category: "readonly",
      description: "Read the deterministic prompt-cache smoke fixture.",
      execute: ({ path }) => {
        fixtureExecutionCount += 1;
        return {
          output: JSON.stringify({
            marker: "OHBABY_REAL_CACHE_FIXTURE_OK",
            path,
          }),
        };
      },
      name: CACHE_FIXTURE_READ,
      parametersJsonSchema: {
        properties: { path: { type: "string" } },
        required: ["path"],
        type: "object",
      },
      source: "builtin",
    },
    createSelectToolsTool(menu),
  ];
  for (const tool of fixtureTools) {
    scheduler.register(tool);
  }
  const mcpAdmission = admitMcpTools(await mcpManager.getAllTools());
  if (mcpAdmission.accepted.length !== 1) {
    throw new Error("real-cache MCP fixture failed admission");
  }
  const admittedMcp = mcpAdmission.accepted[0];
  if (!admittedMcp || admittedMcp.name !== CACHE_FIXTURE_MCP) {
    throw new Error("real-cache MCP fixture discovery returned a wrong tool");
  }
  scheduler.register(admittedMcp);
  menu.setAvailable([admittedMcp.name]);

  const sequence = new ScopeToolSequence();
  const latestEpochs = new Map<string, number>();
  const projections: SanitizedRequestProjection[] = [];
  const usageEvidence: {
    readonly contextScopeId?: string;
    readonly sessionId: string;
    readonly usages: readonly TokenUsage[];
  }[] = [];
  const restoreFetch = installFixtureToolChoice(profile.interfaceProvider);
  let rawClient: LLMClientInstance;
  try {
    rawClient = await createLLMClient({
      env: process.env,
      envPath: join(directory, ".env.absent"),
      modelJsonPath,
      projectDirectory: workdir,
    });
  } catch (error) {
    restoreFetch();
    await Promise.allSettled([mcpManager.dispose(), mcpServer.close()]);
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
  const llmClient = wrapClientWithProjectionRecorder(
    rawClient,
    projections,
    (request) =>
      latestEpochs.get(
        scopeKey(request.sessionId ?? "", request.contextScopeId),
      ) ?? 0,
  );
  const contextManager = createContextManager({
    bus,
    llmClient: createSummaryClient(),
    memory: createEmptyMemory(),
    messageManager,
    systemPromptProvider: createSystemPromptProvider(),
    tokenCounter: createTokenCounter(),
  });
  const lifecycle = new Lifecycle({
    contextManager,
    llmClient,
    messageManager,
    resolveTools: async ({ contextScopeId, sessionId }) => {
      const definitions = await scheduler.getAvailableTools();
      const loaded = menu.loadedNames(
        { contextScopeId, sessionId },
        definitions,
      );
      const visible = definitions.filter(
        (tool) => tool.source !== "mcp" || loaded.has(tool.name),
      );
      const snapshot = sequence.snapshot(
        { contextScopeId, sessionId },
        visible,
      );
      latestEpochs.set(scopeKey(sessionId, contextScopeId), snapshot.epoch);
      return toOpenAiTools(snapshot.tools);
    },
    toolScheduler: scheduler,
  });
  async function saveEvidence(): Promise<void> {
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          interfaceProvider: profile.interfaceProvider,
          minimumCacheableTokens: profile.minimumCacheableTokens,
          model: profile.model,
          projections,
          provider: profile.provider,
          stablePromptTokens,
          usageEvidence,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  return {
    evidencePath,
    fixtureExecutions: () => fixtureExecutionCount,
    projections,
    async activateMcpTool(sessionId, contextScopeId) {
      const result = await scheduler.execute({
        callId: `m13-select-${randomUUID()}`,
        ...(contextScopeId === undefined ? {} : { contextScopeId }),
        messageId: `m13-message-${randomUUID()}`,
        params: { tools: [CACHE_FIXTURE_MCP] },
        sessionId,
        toolName: CACHE_FIXTURE_SELECT,
      });
      if (result.status !== "success") {
        throw new Error(
          "M13 failed to load the MCP fixture through the real scheduler",
        );
      }
    },
    async close() {
      try {
        await saveEvidence();
      } finally {
        restoreFetch();
        try {
          await Promise.all([mcpManager.dispose(), mcpServer.close()]);
        } finally {
          await rm(directory, { force: true, recursive: true });
        }
      }
    },
    async metadataUsages(sessionId, contextScopeId) {
      const messages = await messageManager.listBySession(
        sessionId,
        contextScopeId === undefined ? undefined : { contextScopeId },
      );
      return messages.flatMap((message: MessageWithParts) =>
        message.parts.flatMap((part) => {
          const usage = readTokenUsageMetadata(part.metadata);
          return usage === undefined ? [] : [usage];
        }),
      );
    },
    async runTurn(input) {
      const projectionStart = projections.length;
      const user = await messageManager.createMessage({
        agent: input.isSubagent === true ? "explore" : "build",
        ...(input.contextScopeId === undefined
          ? {}
          : { contextScopeId: input.contextScopeId }),
        role: "user",
        sessionId: input.sessionId,
      });
      await messageManager.appendPart(user.id, {
        text: input.prompt,
        type: "text",
      });
      const events: LifecycleEvent[] = [];
      const loop = lifecycle.run({
        agent: input.isSubagent === true ? "explore" : "build",
        ...(input.contextScopeId === undefined
          ? {}
          : { contextScopeId: input.contextScopeId }),
        directory: workdir,
        environment: createEnvironment(workdir),
        initiatingUserMessageId: user.id,
        isSubagent: input.isSubagent === true,
        maxSteps: input.maxSteps ?? 4,
        modelId: profile.model,
        sessionId: input.sessionId,
      });
      let next = await loop.next();
      while (!next.done) {
        events.push(next.value);
        next = await loop.next();
      }
      const result = next.value;
      if (!result.success) {
        throw new Error(
          `real-cache lifecycle failed: ${result.terminalReason ?? result.finishReason}`,
        );
      }
      const usages = events.flatMap((event) =>
        event.type === "llm:complete" && event.tokenUsage !== undefined
          ? [event.tokenUsage]
          : [],
      );
      usageEvidence.push({
        ...(input.contextScopeId === undefined
          ? {}
          : { contextScopeId: input.contextScopeId }),
        sessionId: input.sessionId,
        usages,
      });
      await saveEvidence();
      return {
        events,
        projections: projections.slice(projectionStart),
        result,
        usages,
      };
    },
  };
}

export function uniqueCacheMarker(label: string): string {
  return `${label}-${randomUUID()}`;
}

export const CACHE_FIXTURE_READ_TOOL = CACHE_FIXTURE_READ;
export const CACHE_FIXTURE_MCP_TOOL = CACHE_FIXTURE_MCP;
export const CACHE_FIXTURE_FORCE_MARKER = FORCE_FIXTURE_TOOL_MARKER;
