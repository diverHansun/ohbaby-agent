import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPromptCacheUsageTracker } from "../../packages/ohbaby-agent/src/adapters/ui-inprocess/prompt-cache-usage.js";
import {
  extractCacheUsageEvidence,
  extractCacheErrorCode,
} from "./responses-cache-evidence.js";
import { describe, expect, it } from "vitest";
import { createBus } from "../../packages/ohbaby-agent/src/bus/index.js";
import { toModelTools } from "../../packages/ohbaby-agent/src/core/agents/index.js";
import {
  createContextManager,
  type ContextLLMClient,
  type ContextManager,
  type MemoryReader,
  type PreparedTurn,
  type SystemPromptProvider,
  type TokenCounter,
} from "../../packages/ohbaby-agent/src/core/context/index.js";
import {
  Lifecycle,
  type LifecycleEvent,
  type LifecycleResult,
} from "../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import type { LLMClientInstance } from "../../packages/ohbaby-agent/src/core/llm-client/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  readTokenUsageMetadata,
} from "../../packages/ohbaby-agent/src/core/message/index.js";
import {
  createToolScheduler,
  type ToolExecutionEnvironment,
} from "../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import { createPermissionState } from "../../packages/ohbaby-agent/src/permission/index.js";
import {
  createInterfaceProvider,
  type InterfaceProviderKind,
  type InterfaceProviderRequest,
  type InterfaceProviderTokenUsage,
} from "../../packages/ohbaby-agent/src/services/interface-providers/index.js";

const ENABLE_ENV = "OHBABY_RUN_REAL_RESPONSES_MIGRATION";
const SELECT_ENV = "OHBABY_REAL_MIGRATION_PROTOCOL";
const PROFILE_ENV = "OHBABY_REAL_MIGRATION_PROFILE";
const EXTENDED_ENV = "OHBABY_REAL_MIGRATION_EXTENDED";
const TOOL_NAME = "migration_probe";

interface Profile {
  readonly id: string;
  readonly apiKeyEnv: string;
  readonly baseUrl: string;
  readonly providerId: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly maxTokens: number;
  readonly model: string;
  readonly protocol: "anthropic" | "openai-compatible" | "openai-responses";
  readonly timeoutMs: number;
  readonly urlPath: string;
}

const PROFILES: readonly Profile[] = [
  {
    id: "zenmux-responses",
    apiKeyEnv: "ZENMUX_API_KEY",
    baseUrl: "https://zenmux.ai/api/v1",
    providerId: "zenmux",
    interfaceProvider: "openai-responses",
    maxTokens: 512,
    model: "x-ai/grok-4.2-fast-non-reasoning",
    protocol: "openai-responses",
    timeoutMs: 45_000,
    urlPath: "/api/v1/responses",
  },
  {
    id: "zenmux-deepseek-chat",
    apiKeyEnv: "ZENMUX_API_KEY",
    baseUrl: "https://zenmux.ai/api/v1",
    providerId: "zenmux",
    interfaceProvider: "openai-compatible",
    maxTokens: 2_048,
    model: "deepseek/deepseek-v4.1-flash",
    protocol: "openai-compatible",
    timeoutMs: 60_000,
    urlPath: "/api/v1/chat/completions",
  },
  {
    id: "zenmux-anthropic",
    apiKeyEnv: "ZENMUX_API_KEY",
    baseUrl: "https://zenmux.ai/api/anthropic",
    providerId: "zenmux",
    interfaceProvider: "anthropic",
    maxTokens: 2_048,
    model: "qwen/qwen3.8-flash",
    protocol: "anthropic",
    timeoutMs: 60_000,
    urlPath: "/api/anthropic/v1/messages",
  },
];

const EXTRA_PROFILES: readonly Profile[] = [
  {
    id: "zenmux-deepseek-v4-chat",
    apiKeyEnv: "ZENMUX_API_KEY",
    baseUrl: "https://zenmux.ai/api/v1",
    providerId: "zenmux",
    interfaceProvider: "openai-compatible",
    protocol: "openai-compatible",
    model: "deepseek/deepseek-v4-flash",
    maxTokens: 2048,
    timeoutMs: 90_000,
    urlPath: "/api/v1/chat/completions",
  },
  {
    id: "zenmux-deepseek-v4-anthropic",
    apiKeyEnv: "ZENMUX_API_KEY",
    baseUrl: "https://zenmux.ai/api/anthropic",
    providerId: "zenmux",
    interfaceProvider: "anthropic",
    protocol: "anthropic",
    model: "deepseek/deepseek-v4-flash",
    maxTokens: 2048,
    timeoutMs: 90_000,
    urlPath: "/api/anthropic/v1/messages",
  },
  {
    id: "zenmux-claude-sonnet5-anthropic",
    apiKeyEnv: "ZENMUX_API_KEY",
    baseUrl: "https://zenmux.ai/api/anthropic",
    providerId: "zenmux",
    interfaceProvider: "anthropic",
    protocol: "anthropic",
    model: "anthropic/claude-sonnet-5",
    maxTokens: 2048,
    timeoutMs: 90_000,
    urlPath: "/api/anthropic/v1/messages",
  },
  {
    id: "zenmux-gpt56-luna-responses",
    apiKeyEnv: "ZENMUX_API_KEY",
    baseUrl: "https://zenmux.ai/api/v1",
    providerId: "zenmux",
    interfaceProvider: "openai-responses",
    protocol: "openai-responses",
    model: "openai/gpt-5.6-luna",
    maxTokens: 2048,
    timeoutMs: 90_000,
    urlPath: "/api/v1/responses",
  },
  {
    id: "zenmux-gpt56-luna-chat",
    apiKeyEnv: "ZENMUX_API_KEY",
    baseUrl: "https://zenmux.ai/api/v1",
    providerId: "zenmux",
    interfaceProvider: "openai-compatible",
    protocol: "openai-compatible",
    model: "openai/gpt-5.6-luna",
    maxTokens: 2048,
    timeoutMs: 90_000,
    urlPath: "/api/v1/chat/completions",
  },
  {
    id: "bailian-qwen-responses",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    providerId: "aliyun",
    interfaceProvider: "openai-responses",
    protocol: "openai-responses",
    model: "qwen3.8-flash",
    maxTokens: 4096,
    timeoutMs: 90_000,
    urlPath: "/compatible-mode/v1/responses",
  },
  {
    id: "bailian-qwen-anthropic",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    providerId: "aliyun",
    interfaceProvider: "anthropic",
    protocol: "anthropic",
    model: "qwen3.8-flash",
    maxTokens: 4096,
    timeoutMs: 90_000,
    urlPath: "/apps/anthropic/v1/messages",
  },
  {
    id: "zhipu-glm-anthropic",
    apiKeyEnv: "ZAI_API_KEY",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    providerId: "zhipu",
    interfaceProvider: "anthropic",
    protocol: "anthropic",
    model: "glm-5.3",
    maxTokens: 8192,
    timeoutMs: 120_000,
    urlPath: "/api/anthropic/v1/messages",
  },
  {
    id: "zenmux-qwen-chat",
    apiKeyEnv: "ZENMUX_API_KEY",
    baseUrl: "https://zenmux.ai/api/v1",
    providerId: "zenmux",
    interfaceProvider: "openai-compatible",
    protocol: "openai-compatible",
    model: "qwen/qwen3.8-flash",
    maxTokens: 2048,
    timeoutMs: 60_000,
    urlPath: "/api/v1/chat/completions",
  },
  {
    id: "bailian-qwen-chat",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    providerId: "aliyun",
    interfaceProvider: "openai-compatible",
    protocol: "openai-compatible",
    model: "qwen3.8-flash",
    maxTokens: 4096,
    timeoutMs: 90_000,
    urlPath: "/compatible-mode/v1/chat/completions",
  },
  {
    id: "zhipu-glm-chat",
    apiKeyEnv: "ZAI_API_KEY",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    providerId: "zhipu",
    interfaceProvider: "openai-compatible",
    protocol: "openai-compatible",
    model: "glm-5.3",
    maxTokens: 8192,
    timeoutMs: 120_000,
    urlPath: "/api/paas/v4/chat/completions",
  },
];

interface CapturedRequest {
  readonly body: Record<string, unknown>;
  readonly path: string;
  status?: number;
  errorCode?: string | number;
  rawUsage?: readonly Record<string, unknown>[];
}

interface PreparedObservation {
  readonly prepared: PreparedTurn;
  readonly sessionId: string;
}

interface CalibrationObservation {
  readonly actualInputTokens: number;
  readonly sentHeuristic: number;
  readonly sessionId: string;
}

function selectedProfiles(): readonly Profile[] {
  const all = [...PROFILES, ...EXTRA_PROFILES];
  const profileId = process.env[PROFILE_ENV]?.trim();
  if (profileId) {
    const match = all.find((profile) => profile.id === profileId);
    if (!match)
      throw new Error(`${PROFILE_ENV} must select a supported profile.`);
    return [match];
  }
  const selected = process.env[SELECT_ENV]?.trim();
  if (selected) {
    const match = PROFILES.find((profile) => profile.protocol === selected);
    if (!match)
      throw new Error(`${SELECT_ENV} must select a supported protocol.`);
    return [match];
  }
  return process.env[EXTENDED_ENV] === "1" ? all : PROFILES;
}

function createEnvironment(workdir: string): ToolExecutionEnvironment {
  return {
    workdir,
    resolvePath: (path) => `${workdir}/${path}`,
    resolvePathForExisting: (path) => Promise.resolve(`${workdir}/${path}`),
    resolvePathForWrite: (path) => Promise.resolve(`${workdir}/${path}`),
    resolveCommandContext: () => ({ cwd: workdir, kind: "host-local" }),
  };
}

function createMemory(): MemoryReader {
  return {
    load: () => Promise.resolve({ global: "", merged: "", project: "" }),
  };
}

function createSystemPrompt(): SystemPromptProvider {
  return {
    build: () =>
      Promise.resolve(
        [
          "Follow the synthetic verification request exactly. Never call a tool unless the user explicitly asks.",
          ...Array.from(
            { length: 160 },
            (_, index) =>
              `Synthetic cache observation rule ${String(index + 1).padStart(3, "0")}: keep the ordered reference context intact and follow the latest user request; never repeat these reference rules in your answer.`,
          ),
        ].join("\n"),
      ),
  };
}

function createTokenCounter(): TokenCounter {
  return {
    estimateTokens: (content) => Math.ceil(content.length / 4),
    getLimit: () => 100_000,
  };
}

function createSummaryClient(): ContextLLMClient {
  return {
    generateSummary: () =>
      Promise.resolve("<state_snapshot>unused smoke summary</state_snapshot>"),
  };
}

async function requestBody(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) {
  if (typeof init?.body === "string") return init.body;
  return input instanceof Request ? input.clone().text() : "";
}

function installPassiveRequestCapture(
  captured: CapturedRequest[],
  requestTimeoutMs: number,
): {
  readonly fail: () => void;
  readonly restore: () => void;
  readonly settled: () => Promise<void>;
} {
  const originalFetch = globalThis.fetch;
  let failed = false;
  const captures: Promise<void>[] = [];
  globalThis.fetch = async (input, init) => {
    if (failed) {
      throw new Error("Real migration path stopped after its first failure.");
    }
    if (captured.length >= 4) {
      failed = true;
      throw new Error("Real migration request budget exhausted.");
    }
    const url = new URL(input instanceof Request ? input.url : String(input));
    const rawBody = await requestBody(input, init);
    const capture: CapturedRequest = {
      body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
      path: url.pathname,
    };
    captured.push(capture);
    try {
      const parentSignal =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const requestSignal = AbortSignal.timeout(requestTimeoutMs);
      const response = await originalFetch(input, {
        ...init,
        signal: parentSignal
          ? AbortSignal.any([parentSignal, requestSignal])
          : requestSignal,
      });
      capture.status = response.status;
      if (!response.ok) failed = true;
      captures.push(
        response
          .clone()
          .text()
          .then((wire) => {
            capture.rawUsage = extractCacheUsageEvidence(wire);
            capture.errorCode = extractCacheErrorCode(wire);
          })
          .catch(() => {
            capture.rawUsage = [];
          }),
      );
      return response;
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  return {
    settled: async () => {
      await Promise.all(captures);
    },
    fail: () => {
      failed = true;
    },
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function consume(
  lifecycle: Lifecycle,
  params: Parameters<Lifecycle["run"]>[0],
): Promise<{
  readonly events: LifecycleEvent[];
  readonly result: LifecycleResult;
}> {
  const events: LifecycleEvent[] = [];
  const loop = lifecycle.run(params);
  let next = await loop.next();
  while (!next.done) {
    events.push(next.value);
    next = await loop.next();
  }
  return { events, result: next.value };
}

function safeFailure(error: unknown): Error {
  const kind = error instanceof Error ? error.name : typeof error;
  const localFrames =
    error instanceof Error
      ? (error.stack?.match(/interface-providers\/[a-z-]+\.ts:\d+:\d+/g) ?? [])
      : [];
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { readonly status?: unknown }).status
      : undefined;
  return new Error(
    `Real migration request failed (${kind}${typeof status === "number" ? `, HTTP ${String(status)}` : ""}${localFrames.length ? `, ${localFrames.join(", ")}` : ""}).`,
  );
}

async function safelyConsume(
  lifecycle: Lifecycle,
  params: Parameters<Lifecycle["run"]>[0],
): Promise<{
  readonly events: LifecycleEvent[];
  readonly result: LifecycleResult;
}> {
  try {
    return await consume(lifecycle, params);
  } catch (error) {
    throw safeFailure(error);
  }
}

function assertCompleted(
  result: LifecycleResult,
  evidence: {
    readonly actualHttpRequests: number;
    readonly profile: Profile;
    readonly providerCalls: number;
  },
): void {
  if (
    !result.success ||
    result.finishReason !== "stop" ||
    result.terminalReason !== "completed"
  ) {
    console.info(
      JSON.stringify({
        actualHttpRequests: evidence.actualHttpRequests,
        finishReason: result.finishReason,
        model: evidence.profile.model,
        protocol: evidence.profile.protocol,
        providerCalls: evidence.providerCalls,
        success: false,
        terminalReason: result.terminalReason,
      }),
    );
    throw new Error("Real migration lifecycle did not complete normally.");
  }
}

function hasPositiveUsage(result: LifecycleResult): boolean {
  return (
    result.usage?.usageComplete === true &&
    result.usage.inputTokens > 0 &&
    result.usage.outputTokens > 0 &&
    result.usage.totalTokens ===
      result.usage.inputTokens + result.usage.outputTokens
  );
}

function assertValidUsage(usage: InterfaceProviderTokenUsage): void {
  expect(usage.inputTokens).toBeGreaterThan(0);
  expect(usage.outputTokens).toBeGreaterThan(0);
  expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
  if (usage.inputBreakdown !== undefined) {
    expect(usage.inputBreakdown.uncached).toBeGreaterThanOrEqual(0);
    expect(usage.inputBreakdown.cacheRead).toBeGreaterThanOrEqual(0);
    expect(usage.inputBreakdown.cacheWrite).toBeGreaterThanOrEqual(0);
    expect(
      usage.inputBreakdown.uncached +
        usage.inputBreakdown.cacheRead +
        usage.inputBreakdown.cacheWrite,
    ).toBe(usage.inputTokens);
  }
}

function sumUsage(
  usages: readonly InterfaceProviderTokenUsage[],
): InterfaceProviderTokenUsage {
  return usages.reduce<InterfaceProviderTokenUsage>(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

function usageNumbers(usage: InterfaceProviderTokenUsage | undefined) {
  if (usage === undefined) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.inputBreakdown === undefined
      ? {}
      : {
          inputBreakdown: {
            cacheRead: usage.inputBreakdown.cacheRead,
            cacheWrite: usage.inputBreakdown.cacheWrite,
            uncached: usage.inputBreakdown.uncached,
          },
        }),
  };
}

async function assertPersistedStepUsage(
  messageManager: ReturnType<typeof createMessageManager>,
  sessionId: string,
  nativeUsages: readonly InterfaceProviderTokenUsage[],
): Promise<number[]> {
  const assistantMessages = (
    await messageManager.listBySession(sessionId)
  ).filter((message) => message.info.role === "assistant");
  expect(assistantMessages).toHaveLength(nativeUsages.length);
  return assistantMessages.map((message, index) => {
    const carrying = message.parts
      .map((part) => readTokenUsageMetadata(part.metadata))
      .filter((usage) => usage !== undefined);
    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toEqual(nativeUsages[index]);
    return carrying.length;
  });
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

function assertNativeToolResult(
  profile: Profile,
  body: Record<string, unknown>,
  callId: string,
  verification: string,
): void {
  let callMatches = false;
  let resultMatches = false;
  if (profile.protocol === "openai-responses") {
    const input = records(body.input);
    callMatches = input.some(
      (item) => item.type === "function_call" && item.call_id === callId,
    );
    resultMatches = input.some(
      (item) =>
        item.type === "function_call_output" &&
        item.call_id === callId &&
        item.output === verification,
    );
  } else if (profile.protocol === "openai-compatible") {
    const messages = records(body.messages);
    callMatches = messages.some((message) =>
      records(message.tool_calls).some(
        (call) => call.type === "function" && call.id === callId,
      ),
    );
    resultMatches = messages.some(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === callId &&
        message.content === verification,
    );
  } else {
    const blocks = records(body.messages).flatMap((message) =>
      records(message.content),
    );
    callMatches = blocks.some(
      (block) => block.type === "tool_use" && block.id === callId,
    );
    resultMatches = blocks.some(
      (block) =>
        block.type === "tool_result" &&
        block.tool_use_id === callId &&
        block.content === verification,
    );
  }
  if (!callMatches || !resultMatches) {
    throw new Error("Native tool call/result correlation was not preserved.");
  }
}

const enabled = process.env[ENABLE_ENV] === "1";

describe.skipIf(!enabled)("real Responses migration matrix", () => {
  it("has explicit credentials for the selected real profiles", () => {
    for (const profile of selectedProfiles()) {
      expect(
        Boolean(process.env[profile.apiKeyEnv]?.trim()),
        profile.apiKeyEnv,
      ).toBe(true);
    }
  });

  for (const profile of selectedProfiles()) {
    const apiKey = process.env[profile.apiKeyEnv]?.trim();
    it.skipIf(!apiKey)(
      `${profile.id} completes text, tool round trip and cumulative cache observation`,
      async () => {
        if (!apiKey)
          throw new Error(`${profile.apiKeyEnv} is required by the real gate.`);

        const cacheTracker = createPromptCacheUsageTracker();
        const stepObservations: {
          sessionId: string;
          step: number;
          tokenUsage: InterfaceProviderTokenUsage | undefined;
        }[] = [];
        const observe =
          (sessionId: string) =>
          (observation: {
            step: number;
            tokenUsage: InterfaceProviderTokenUsage | undefined;
          }): void => {
            stepObservations.push({ sessionId, ...observation });
            cacheTracker.record(sessionId, observation.tokenUsage);
          };
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
        let fixtureExecutions = 0;
        let verification: string | undefined;
        scheduler.register({
          category: "readonly",
          description:
            "Generate the private verification value for this synthetic migration probe.",
          execute: () => {
            fixtureExecutions += 1;
            verification = `OHBABY_MIGRATION_${randomUUID()}`;
            return { output: verification };
          },
          name: TOOL_NAME,
          parametersJsonSchema: {
            additionalProperties: false,
            properties: {},
            type: "object",
          },
          source: "builtin",
        });

        const requests: InterfaceProviderRequest[] = [];
        const nativeUsages: InterfaceProviderTokenUsage[] = [];
        const preparations: PreparedObservation[] = [];
        const calibrations: CalibrationObservation[] = [];
        const captured: CapturedRequest[] = [];
        const fetchGuard = installPassiveRequestCapture(
          captured,
          profile.timeoutMs,
        );
        const deadline = AbortSignal.timeout(profile.timeoutMs * 4 + 10_000);
        const provider = createInterfaceProvider({
          apiKey,
          baseUrl: profile.baseUrl,
          id: profile.providerId,
          interfaceProvider: profile.interfaceProvider,
        });
        Reflect.set(provider.client as object, "maxRetries", 0);
        const stream = provider.streamResponse.bind(provider);
        const llmClient: LLMClientInstance = {
          config: {
            baseUrl: profile.baseUrl,
            interfaceProvider: profile.interfaceProvider,
            maxTokens: profile.maxTokens,
            model: profile.model,
            promptCache: "auto",
            provider: profile.providerId,
            temperature: 0.2,
          },
          provider: {
            ...provider,
            async streamResponse(request) {
              requests.push(request);
              try {
                const source = await stream(request);
                return (async function* () {
                  let finalUsage: InterfaceProviderTokenUsage | undefined;
                  try {
                    for await (const event of source) {
                      if (event.tokenUsage !== undefined) {
                        finalUsage = event.tokenUsage;
                      }
                      yield event;
                    }
                    if (finalUsage !== undefined) nativeUsages.push(finalUsage);
                  } catch (error) {
                    fetchGuard.fail();
                    throw error;
                  }
                })();
              } catch (error) {
                fetchGuard.fail();
                throw error;
              }
            },
          },
        };
        const baseContextManager = createContextManager({
          bus,
          llmClient: createSummaryClient(),
          memory: createMemory(),
          messageManager,
          systemPromptProvider: createSystemPrompt(),
          tokenCounter: createTokenCounter(),
        });
        const prepareTurn =
          baseContextManager.prepareTurn.bind(baseContextManager);
        const updateCalibrationFactor =
          baseContextManager.updateCalibrationFactor.bind(baseContextManager);
        const contextManager: ContextManager = {
          ...baseContextManager,
          async prepareTurn(input) {
            const prepared = await prepareTurn(input);
            preparations.push({ prepared, sessionId: input.sessionId });
            return prepared;
          },
          updateCalibrationFactor(
            sessionId,
            actualInputTokens,
            sentHeuristic,
            contextScopeId,
          ) {
            calibrations.push({
              actualInputTokens,
              sentHeuristic,
              sessionId,
            });
            updateCalibrationFactor(
              sessionId,
              actualInputTokens,
              sentHeuristic,
              contextScopeId,
            );
          },
        };
        const lifecycle = new Lifecycle({
          contextManager,
          llmClient,
          messageManager,
          toolScheduler: scheduler,
        });
        const workdir = "/tmp/ohbaby-responses-migration-smoke";
        let passed = false;

        try {
          const textSession = `text-${randomUUID()}`;
          const textMarker = `OHBABY_TEXT_${randomUUID()}`;
          const textMessage = await messageManager.createMessage({
            agent: "build",
            role: "user",
            sessionId: textSession,
          });
          await messageManager.appendPart(textMessage.id, {
            text: `Reply with exactly ${textMarker}. Do not call tools.`,
            type: "text",
          });
          const text = await safelyConsume(lifecycle, {
            agent: "build",
            directory: workdir,
            initiatingUserMessageId: textMessage.id,
            maxSteps: 2,
            modelId: profile.model,
            sessionId: textSession,
            onStepUsage: observe(textSession),
            signal: deadline,
          });
          assertCompleted(text.result, {
            actualHttpRequests: captured.length,
            profile,
            providerCalls: requests.length,
          });
          expect(text.result.finalResponse.trim()).toBe(textMarker);
          expect(hasPositiveUsage(text.result)).toBe(true);

          const toolSession = `tool-${randomUUID()}`;
          const toolMessage = await messageManager.createMessage({
            agent: "build",
            role: "user",
            sessionId: toolSession,
          });
          await messageManager.appendPart(toolMessage.id, {
            text: `Call ${TOOL_NAME} exactly once with no arguments. Then reply with exactly the tool result and call no more tools.`,
            type: "text",
          });
          const tool = await safelyConsume(lifecycle, {
            agent: "build",
            directory: workdir,
            environment: createEnvironment(workdir),
            initiatingUserMessageId: toolMessage.id,
            maxSteps: 3,
            modelId: profile.model,
            sessionId: toolSession,
            onStepUsage: observe(toolSession),
            signal: deadline,
            tools: toModelTools(await scheduler.getAvailableTools()),
          });

          assertCompleted(tool.result, {
            actualHttpRequests: captured.length,
            profile,
            providerCalls: requests.length,
          });
          expect(fixtureExecutions).toBe(1);
          expect(Boolean(verification)).toBe(true);
          expect(tool.result.finalResponse.trim()).toBe(verification);
          expect(hasPositiveUsage(tool.result)).toBe(true);
          expect(tool.result.toolCalls).toHaveLength(1);
          const callId = tool.result.toolCalls?.[0]?.callId;
          expect(Boolean(callId)).toBe(true);
          expect(
            tool.events.some(
              (event) =>
                event.type === "tool:result" && event.callId === callId,
            ),
          ).toBe(true);

          expect(requests).toHaveLength(3);
          expect(
            requests.every((request) => request.purpose === "agent-step"),
          ).toBe(true);
          expect(
            requests.every(
              (request) => request.maxTokens === profile.maxTokens,
            ),
          ).toBe(true);
          expect(
            requests.every((request) =>
              profile.protocol === "openai-responses"
                ? request.promptCache.strategy === "observe-only"
                : true,
            ),
          ).toBe(true);
          expect(captured).toHaveLength(3);
          expect(
            captured.every((request) => request.path === profile.urlPath),
          ).toBe(true);
          expect(
            captured.every((request) =>
              profile.protocol === "openai-responses"
                ? request.body.store === false
                : request.body.store === undefined,
            ),
          ).toBe(true);
          expect(
            captured.every((request) => request.body.model === profile.model),
          ).toBe(true);
          expect(preparations).toHaveLength(3);
          expect(nativeUsages).toHaveLength(3);
          expect(calibrations).toHaveLength(3);
          for (const [index, request] of requests.entries()) {
            const observation = preparations[index];
            const usage = nativeUsages[index];
            const calibration = calibrations[index];
            if (
              observation === undefined ||
              usage === undefined ||
              calibration === undefined
            ) {
              throw new Error("Per-step usage evidence is incomplete.");
            }
            assertValidUsage(usage);
            expect(request.messages).toEqual(
              observation.prepared.request.messages,
            );
            expect(request.tools).toEqual(observation.prepared.request.tools);
            expect(calibration).toEqual({
              actualInputTokens: usage.inputTokens,
              sentHeuristic: observation.prepared.sentHeuristic,
              sessionId: observation.sessionId,
            });
            expect(calibration.sentHeuristic).toBeGreaterThan(0);
          }

          const textUsage = sumUsage(nativeUsages.slice(0, 1));
          const toolUsage = sumUsage(nativeUsages.slice(1));
          expect(text.result.usage).toMatchObject(textUsage);
          expect(tool.result.usage).toMatchObject(toolUsage);

          const textCarryingCounts = await assertPersistedStepUsage(
            messageManager,
            textSession,
            nativeUsages.slice(0, 1),
          );
          const toolCarryingCounts = await assertPersistedStepUsage(
            messageManager,
            toolSession,
            nativeUsages.slice(1),
          );

          const firstToolPreparation = preparations[1]?.prepared;
          const nextToolPreparation = preparations[2]?.prepared;
          const firstToolCalibration = calibrations[1];
          if (
            firstToolPreparation === undefined ||
            nextToolPreparation === undefined ||
            firstToolCalibration === undefined
          ) {
            throw new Error("Tool calibration evidence is incomplete.");
          }
          expect(firstToolPreparation.usage.currentTokens).toBe(
            firstToolPreparation.sentHeuristic,
          );
          const observedToolFactor =
            firstToolCalibration.actualInputTokens /
            firstToolCalibration.sentHeuristic;
          const clampedToolFactor = Math.min(
            3,
            Math.max(0.5, observedToolFactor),
          );
          const expectedNextToolFactor = 0.5 * clampedToolFactor + 0.5 * 1;
          expect(nextToolPreparation.usage.currentTokens).toBe(
            Math.round(
              nextToolPreparation.sentHeuristic * expectedNextToolFactor,
            ),
          );
          if (verification === undefined || callId === undefined) {
            throw new Error("Tool execution evidence is incomplete.");
          }
          expect(JSON.stringify(captured[0]?.body).includes(verification)).toBe(
            false,
          );
          expect(JSON.stringify(captured[1]?.body).includes(verification)).toBe(
            false,
          );
          const continuation = captured[2];
          if (!continuation) {
            throw new Error("Tool continuation request was not captured.");
          }
          assertNativeToolResult(
            profile,
            continuation.body,
            callId,
            verification,
          );
          const followupMessage = await messageManager.createMessage({
            agent: "build",
            role: "user",
            sessionId: toolSession,
          });
          await messageManager.appendPart(followupMessage.id, {
            type: "text",
            text: "Reply with exactly CACHE_FOLLOWUP_OK. Do not call tools.",
          });
          const followup = await safelyConsume(lifecycle, {
            agent: "build",
            directory: workdir,
            initiatingUserMessageId: followupMessage.id,
            maxSteps: 2,
            modelId: profile.model,
            sessionId: toolSession,
            signal: deadline,
            onStepUsage: observe(toolSession),
            tools: toModelTools(await scheduler.getAvailableTools()),
          });
          assertCompleted(followup.result, {
            actualHttpRequests: captured.length,
            profile,
            providerCalls: requests.length,
          });
          expect(followup.result.finalResponse.trim()).toBe(
            "CACHE_FOLLOWUP_OK",
          );
          expect(stepObservations).toHaveLength(4);
          expect(nativeUsages).toHaveLength(4);
          expect(captured).toHaveLength(4);
          expect(requests).toHaveLength(4);
          expect(preparations).toHaveLength(4);
          expect(calibrations).toHaveLength(4);
          const lastRequest = requests[3];
          const lastPrepared = preparations[3];
          const lastUsage = nativeUsages[3];
          if (!lastRequest || !lastPrepared || !lastUsage)
            throw new Error("Follow-up evidence missing.");
          assertValidUsage(lastUsage);
          expect(followup.result.usage).toMatchObject(lastUsage);
          expect(lastRequest).toMatchObject({
            purpose: "agent-step",
            model: profile.model,
            maxTokens: profile.maxTokens,
            messages: lastPrepared.prepared.request.messages,
            tools: lastPrepared.prepared.request.tools,
          });
          expect(calibrations[3]).toEqual({
            actualInputTokens: lastUsage.inputTokens,
            sentHeuristic: lastPrepared.prepared.sentHeuristic,
            sessionId: toolSession,
          });
          expect(captured[3]?.path).toBe(profile.urlPath);
          expect(captured[3]?.body.model).toBe(profile.model);
          expect(captured[3]?.body.store).toBe(
            profile.protocol === "openai-responses" ? false : undefined,
          );
          if (profile.protocol === "openai-responses")
            expect(lastRequest.promptCache.strategy).toBe("observe-only");
          const stableSystem = requests[1]?.messages.find(
            (message) => message.role === "system",
          )?.content;
          expect(JSON.stringify(stableSystem)).toContain(
            "Synthetic cache observation rule 160",
          );
          for (const request of requests.slice(1)) {
            expect(
              request.messages.find((message) => message.role === "system")
                ?.content,
            ).toEqual(stableSystem);
            expect(request.tools).toEqual(requests[1]?.tools);
          }
          expect(
            nativeUsages.slice(1).every((usage) => usage.inputTokens >= 1024),
          ).toBe(true);
          const finalToolCarryingCounts = await assertPersistedStepUsage(
            messageManager,
            toolSession,
            nativeUsages.slice(1),
          );
          expect(
            stepObservations.map((observation) => observation.tokenUsage),
          ).toEqual(nativeUsages);
          for (const sessionId of [textSession, toolSession]) {
            const known = stepObservations.filter(
              (observation) =>
                observation.sessionId === sessionId &&
                observation.tokenUsage?.inputBreakdown?.observed.cacheRead ===
                  true,
            );
            const input = known.reduce(
              (sum, item) => sum + (item.tokenUsage?.inputTokens ?? 0),
              0,
            );
            const read = known.reduce(
              (sum, item) =>
                sum + (item.tokenUsage?.inputBreakdown?.cacheRead ?? 0),
              0,
            );
            expect(cacheTracker.get(sessionId)).toEqual({
              sessionId,
              accountedInputTokens: input,
              cacheReadTokens: read,
              cacheReadShare: input === 0 ? null : read / input,
            });
          }
          await fetchGuard.settled();
          expect(
            captured.every((request) => (request.rawUsage?.length ?? 0) > 0),
          ).toBe(true);
          for (const [index, capturedRequest] of captured.entries()) {
            const normalized = nativeUsages[index];
            if (!normalized)
              throw new Error("Missing corresponding normalized usage.");
            const rawSnapshots = capturedRequest.rawUsage ?? [];
            const inputSnapshots = rawSnapshots.filter((raw, index) => {
              const inputKeys = [
                "input_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
              ];
              return !(
                profile.protocol === "anthropic" &&
                inputKeys.every((key) => raw[key] === 0) &&
                rawSnapshots
                  .slice(0, index)
                  .some((previous) =>
                    inputKeys.some(
                      (key) =>
                        typeof previous[key] === "number" && previous[key] > 0,
                    ),
                  )
              );
            });
            const number = (
              key: string,
              parent?: string,
              includePlaceholder = false,
            ): number | undefined => {
              const values = (
                key === "output_tokens" || includePlaceholder
                  ? rawSnapshots
                  : inputSnapshots
              ).flatMap((raw) => {
                const source = parent === undefined ? raw : raw[parent];
                const value =
                  typeof source === "object" && source !== null
                    ? (source as Record<string, unknown>)[key]
                    : undefined;
                return typeof value === "number" &&
                  Number.isInteger(value) &&
                  value >= 0
                  ? [value]
                  : [];
              });
              return values.length === 0
                ? undefined
                : profile.protocol === "anthropic" && key === "output_tokens"
                  ? Math.max(...values)
                  : values[values.length - 1];
            };
            const nativeHit = number("prompt_cache_hit_tokens");
            const nativeMiss = number("prompt_cache_miss_tokens");
            const nativePair =
              nativeHit !== undefined || nativeMiss !== undefined;
            const details =
              profile.protocol === "openai-responses"
                ? "input_tokens_details"
                : "prompt_tokens_details";
            const rawRead =
              profile.protocol === "anthropic"
                ? number("cache_read_input_tokens", undefined, true) ===
                  undefined
                  ? undefined
                  : (number("cache_read_input_tokens") ?? 0)
                : nativePair
                  ? nativeHit
                  : number("cached_tokens", details);
            const rawWrite =
              profile.protocol === "anthropic"
                ? number("cache_creation_input_tokens", undefined, true) ===
                  undefined
                  ? undefined
                  : (number("cache_creation_input_tokens") ?? 0)
                : nativePair
                  ? undefined
                  : number("cache_write_tokens", details);
            const rawInput =
              profile.protocol === "anthropic"
                ? number("input_tokens") === undefined
                  ? undefined
                  : number("input_tokens")! + (rawRead ?? 0) + (rawWrite ?? 0)
                : profile.protocol === "openai-responses"
                  ? number("input_tokens")
                  : (number("prompt_tokens") ??
                    (nativeHit !== undefined && nativeMiss !== undefined
                      ? nativeHit + nativeMiss
                      : undefined));
            const rawOutput = number(
              profile.protocol === "openai-compatible"
                ? "completion_tokens"
                : "output_tokens",
            );
            expect(normalized.inputTokens).toBe(rawInput);
            expect(normalized.outputTokens).toBe(rawOutput);
            expect(normalized.totalTokens).toBe(
              (rawInput ?? 0) + (rawOutput ?? 0),
            );
            expect(normalized.inputBreakdown?.observed.cacheRead ?? false).toBe(
              rawRead !== undefined,
            );
            expect(
              normalized.inputBreakdown?.observed.cacheWrite ?? false,
            ).toBe(rawWrite !== undefined);
            if (rawRead !== undefined)
              expect(normalized.inputBreakdown?.cacheRead).toBe(rawRead);
            if (rawWrite !== undefined)
              expect(normalized.inputBreakdown?.cacheWrite).toBe(rawWrite);
          }
          console.info(
            JSON.stringify({
              profile: profile.id,
              cache: {
                text: cacheTracker.get(textSession),
                toolSession: cacheTracker.get(toolSession),
              },
              model: profile.model,
              protocol: profile.protocol,
              actualHttpRequests: captured.length,
              providerCalls: requests.length,
              textRequests: 1,
              toolRequests: 2,
              followupRequests: 1,
              text: {
                finishReason: text.result.finishReason,
                terminalReason: text.result.terminalReason,
                usage: usageNumbers(text.result.usage),
              },
              tool: {
                executions: fixtureExecutions,
                finishReason: tool.result.finishReason,
                terminalReason: tool.result.terminalReason,
                usage: usageNumbers(tool.result.usage),
              },
              usageContract: {
                aggregate: {
                  text: usageNumbers(textUsage),
                  tool: usageNumbers(toolUsage),
                },
                calibrationInputs: calibrations.map((calibration) => ({
                  actualInputTokens: calibration.actualInputTokens,
                  sentHeuristic: calibration.sentHeuristic,
                })),
                carryingCounts: [...textCarryingCounts, ...toolCarryingCounts],
                finalToolCarryingCounts,
                finalUsage: nativeUsages.map(usageNumbers),
                rawEstimates: preparations.map(
                  (observation) => observation.prepared.sentHeuristic,
                ),
              },
            }),
          );
          passed = true;
        } finally {
          fetchGuard.restore();
          await fetchGuard.settled();
          const evidenceDir =
            process.env.OHBABY_REAL_CACHE_EVIDENCE_DIR ??
            ".ohbaby/test-evidence/improve-5/real-cache";
          await mkdir(evidenceDir, { recursive: true });
          await writeFile(
            join(evidenceDir, `${profile.id}-${Date.now()}.json`),
            JSON.stringify(
              {
                profile: profile.id,
                passed,
                model: profile.model,
                protocol: profile.protocol,
                baseUrl: profile.baseUrl,
                observedAt: new Date().toISOString(),
                requestStrategies: requests.map((request) => ({
                  purpose: request.purpose,
                  strategy: request.promptCache.strategy,
                })),
                requests: captured.map((request) => ({
                  path: request.path,
                  status: request.status,
                  errorCode: request.errorCode,
                  rawUsage: request.rawUsage,
                })),
                stepObservations,
                cache: [
                  ...new Set(
                    stepObservations.map(
                      (observation) => observation.sessionId,
                    ),
                  ),
                ].map((sessionId) => cacheTracker.get(sessionId)),
              },
              null,
              2,
            ),
          );
          console.info(
            JSON.stringify({
              kind: "request-budget-summary",
              model: profile.model,
              protocol: profile.protocol,
              actualHttpRequests: captured.length,
              providerCalls: requests.length,
              toolExecutions: fixtureExecutions,
            }),
          );
        }
      },
      profile.timeoutMs * 4 + 30_000,
    );
  }
});
