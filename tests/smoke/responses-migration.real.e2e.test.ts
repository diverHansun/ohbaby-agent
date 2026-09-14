import { randomUUID } from "node:crypto";
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
const API_KEY_ENV = "ZENMUX_API_KEY";
const TOOL_NAME = "migration_probe";

interface Profile {
  readonly interfaceProvider: InterfaceProviderKind;
  readonly maxTokens: number;
  readonly model: string;
  readonly protocol: "anthropic" | "openai-compatible" | "openai-responses";
  readonly timeoutMs: number;
  readonly urlPath: string;
}

const PROFILES: readonly Profile[] = [
  {
    interfaceProvider: "openai-responses",
    maxTokens: 512,
    model: "x-ai/grok-4.2-fast-non-reasoning",
    protocol: "openai-responses",
    timeoutMs: 45_000,
    urlPath: "/api/v1/responses",
  },
  {
    interfaceProvider: "openai-compatible",
    maxTokens: 2_048,
    model: "deepseek/deepseek-v4.1-flash",
    protocol: "openai-compatible",
    timeoutMs: 60_000,
    urlPath: "/api/v1/chat/completions",
  },
  {
    interfaceProvider: "anthropic",
    maxTokens: 2_048,
    model: "qwen/qwen3.8-flash",
    protocol: "anthropic",
    timeoutMs: 60_000,
    urlPath: "/api/anthropic/v1/messages",
  },
];

interface CapturedRequest {
  readonly body: Record<string, unknown>;
  readonly path: string;
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
  const selected = process.env[SELECT_ENV]?.trim();
  if (!selected) return PROFILES;
  const match = PROFILES.find((profile) => profile.protocol === selected);
  if (!match) {
    throw new Error(`${SELECT_ENV} must select a supported protocol.`);
  }
  return [match];
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
        "Follow the synthetic verification request exactly. Never call a tool unless the user explicitly asks.",
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

function installPassiveRequestCapture(captured: CapturedRequest[]): {
  readonly fail: () => void;
  readonly restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  let failed = false;
  globalThis.fetch = async (input, init) => {
    if (failed) {
      throw new Error("Real migration path stopped after its first failure.");
    }
    if (captured.length >= 3) {
      failed = true;
      throw new Error("Real migration request budget exhausted.");
    }
    const url = new URL(input instanceof Request ? input.url : String(input));
    const rawBody = await requestBody(input, init);
    captured.push({
      body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
      path: url.pathname,
    });
    try {
      const response = await originalFetch(input, init);
      if (!response.ok) failed = true;
      return response;
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  return {
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
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { readonly status?: unknown }).status
      : undefined;
  return new Error(
    `Real migration request failed (${kind}${typeof status === "number" ? `, HTTP ${String(status)}` : ""}).`,
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
  const apiKey = process.env[API_KEY_ENV]?.trim();

  it("has an explicit ZenMux credential when the real gate is enabled", () => {
    expect(Boolean(apiKey)).toBe(true);
  });

  for (const profile of selectedProfiles()) {
    it.skipIf(!apiKey)(
      `${profile.protocol} completes text and one real lifecycle tool round trip`,
      async () => {
        if (!apiKey)
          throw new Error(`${API_KEY_ENV} is required by the real gate.`);

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
        const fetchGuard = installPassiveRequestCapture(captured);
        const provider = createInterfaceProvider({
          apiKey,
          baseUrl:
            profile.protocol === "anthropic"
              ? "https://zenmux.ai/api/anthropic"
              : "https://zenmux.ai/api/v1",
          id: "zenmux",
          interfaceProvider: profile.interfaceProvider,
        });
        Reflect.set(provider.client as object, "maxRetries", 0);
        const stream = provider.streamResponse.bind(provider);
        const llmClient: LLMClientInstance = {
          config: {
            baseUrl:
              profile.protocol === "anthropic"
                ? "https://zenmux.ai/api/anthropic"
                : "https://zenmux.ai/api/v1",
            interfaceProvider: profile.interfaceProvider,
            maxTokens: profile.maxTokens,
            model: profile.model,
            promptCache: "auto",
            provider: "zenmux",
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
            signal: AbortSignal.timeout(profile.timeoutMs),
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
            signal: AbortSignal.timeout(profile.timeoutMs),
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
          console.info(
            JSON.stringify({
              model: profile.model,
              protocol: profile.protocol,
              actualHttpRequests: captured.length,
              providerCalls: requests.length,
              textRequests: 1,
              toolRequests: 2,
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
                finalUsage: nativeUsages.map(usageNumbers),
                rawEstimates: preparations.map(
                  (observation) => observation.prepared.sentHeuristic,
                ),
              },
            }),
          );
        } finally {
          fetchGuard.restore();
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
      150_000,
    );
  }
});
