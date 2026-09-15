import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus } from "../../packages/ohbaby-agent/src/bus/index.js";
import { createPromptCacheUsageTracker } from "../../packages/ohbaby-agent/src/adapters/ui-inprocess/prompt-cache-usage.js";
import { createContextManager } from "../../packages/ohbaby-agent/src/core/context/index.js";
import {
  Lifecycle,
  type LifecycleResult,
} from "../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
  readTokenUsageMetadata,
} from "../../packages/ohbaby-agent/src/core/message/index.js";
import {
  createToolScheduler,
  type ToolExecutionEnvironment,
} from "../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import { toModelTools } from "../../packages/ohbaby-agent/src/core/agents/index.js";
import { createPermissionState } from "../../packages/ohbaby-agent/src/permission/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../../packages/ohbaby-agent/src/services/database/index.js";
import {
  createInterfaceProvider,
  type InterfaceProviderKind,
  type InterfaceProviderTokenUsage,
} from "../../packages/ohbaby-agent/src/services/interface-providers/index.js";
import type { LLMClientInstance } from "../../packages/ohbaby-agent/src/core/llm-client/index.js";
import type { ReasoningCapabilities } from "../../packages/ohbaby-agent/src/config/llm/types.js";
import type { NativeOutput } from "../../packages/ohbaby-agent/src/services/interface-providers/native-state.js";
import {
  extractCacheErrorCode,
  extractCacheUsageEvidence,
} from "./responses-cache-evidence.js";

export interface NativeRealProfile {
  readonly id: string;
  readonly model: string;
  readonly protocol: InterfaceProviderKind;
  readonly baseUrl: string;
  readonly enabledEffort: string;
  readonly capabilities: ReasoningCapabilities;
  readonly sources: readonly string[];
}
const zenmuxReasoning = "https://zenmux.ai/docs/guide/advanced/reasoning.html";
export const NATIVE_REAL_PROFILES: readonly NativeRealProfile[] = [
  {
    id: "zenmux-deepseek-v4-chat",
    model: "deepseek/deepseek-v4-flash",
    protocol: "openai-compatible",
    baseUrl: "https://zenmux.ai/api/v1",
    enabledEffort: "high",
    capabilities: {
      mode: "effort",
      wire: "reasoning",
      supportsDisabled: true,
      efforts: ["high", "max"],
      temperature: "unsupported",
    },
    sources: [zenmuxReasoning, "https://zenmux.ai/deepseek/deepseek-v4-flash"],
  },
  {
    id: "zenmux-gpt56-luna-responses",
    model: "openai/gpt-5.6-luna",
    protocol: "openai-responses",
    baseUrl: "https://zenmux.ai/api/v1",
    enabledEffort: "medium",
    capabilities: {
      mode: "effort",
      wire: "openai",
      supportsDisabled: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      temperature: "unsupported",
    },
    sources: [
      zenmuxReasoning,
      "https://zenmux.ai/openai/gpt-5.6-luna",
      "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
    ],
  },
  {
    id: "zenmux-claude-sonnet5-anthropic",
    model: "anthropic/claude-sonnet-5",
    protocol: "anthropic",
    baseUrl: "https://zenmux.ai/api/anthropic",
    enabledEffort: "medium",
    capabilities: {
      mode: "effort",
      wire: "anthropic-adaptive",
      supportsDisabled: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      temperature: "unsupported",
    },
    sources: [
      zenmuxReasoning,
      "https://zenmux.ai/anthropic/claude-sonnet-5",
      "https://platform.claude.com/docs/en/docs/about-claude/models/whats-new-sonnet-5",
      "https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5",
    ],
  },
  {
    id: "zenmux-gpt56-luna-chat",
    model: "openai/gpt-5.6-luna",
    protocol: "openai-compatible",
    baseUrl: "https://zenmux.ai/api/v1",
    enabledEffort: "medium",
    capabilities: {
      mode: "effort",
      wire: "reasoning",
      supportsDisabled: true,
      efforts: ["low", "medium", "high"],
      temperature: "unsupported",
    },
    sources: [
      zenmuxReasoning,
      "https://zenmux.ai/openai/gpt-5.6-luna",
      "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
    ],
  },
  {
    id: "zenmux-gpt56-luna-chat-native",
    model: "openai/gpt-5.6-luna",
    protocol: "openai-compatible",
    baseUrl: "https://zenmux.ai/api/v1",
    enabledEffort: "medium",
    capabilities: {
      mode: "effort",
      wire: "openai",
      supportsDisabled: true,
      efforts: ["low", "medium", "high"],
      temperature: "unsupported",
    },
    sources: [
      "https://zenmux.ai/docs/api/openai/create-chat-completion.html",
      "https://zenmux.ai/openai/gpt-5.6-luna",
      "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
    ],
  },
];
export const NATIVE_PROBE_TOOL = "native_continuation_probe";
export const NATIVE_PROBE_RESULT = "NATIVE_TOOL_RESULT_OK";
export const NATIVE_REAL_LIMITS = {
  maxRequests: 4,
  diagnosticAllowance: 2,
  sdkRetries: 0,
  requestTimeoutMs: 90_000,
  maxTokens: 4096,
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const object = record(item);
        return object ? [object] : [];
      })
    : [];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = record(value);
  if (object)
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  return value === undefined ? "null" : JSON.stringify(value);
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
interface NativeFingerprint {
  readonly type: string;
  readonly sha256: string;
}
function nativeItems(output: NativeOutput | undefined): unknown[] {
  if (!output) return [];
  if (output.protocol === "openai-compatible")
    return [
      ...(output.reasoningText === undefined
        ? []
        : [
            {
              type: output.reasoningField ?? "reasoning_content",
              text: output.reasoningText,
            },
          ]),
      ...(output.reasoningDetails ?? []),
    ];
  return output.items.filter(
    (item) =>
      item.type === "reasoning" ||
      item.type === "thinking" ||
      item.type === "redacted_thinking",
  );
}
function fingerprints(items: unknown[]): NativeFingerprint[] {
  return items.map((item) => {
    const type = record(item)?.type;
    return {
      type: typeof type === "string" ? type : "unknown",
      sha256: digest(item),
    };
  });
}
function outgoingNative(
  body: Record<string, unknown>,
  protocol: InterfaceProviderKind,
): unknown[] {
  if (protocol === "openai-responses")
    return records(body.input).filter((item) => item.type === "reasoning");
  const messages = records(body.messages);
  if (protocol === "anthropic")
    return messages
      .flatMap((message) => records(message.content))
      .filter(
        (item) => item.type === "thinking" || item.type === "redacted_thinking",
      );
  return messages.flatMap((message) => [
    ...(typeof message.reasoning_content === "string"
      ? [{ type: "reasoning_content", text: message.reasoning_content }]
      : []),
    ...(typeof message.reasoning === "string"
      ? [{ type: "reasoning", text: message.reasoning }]
      : []),
    ...records(message.reasoning_details),
  ]);
}
function extractNativeUsageEvidence(wire: string): Record<string, unknown>[] {
  const result = extractCacheUsageEvidence(wire);
  let usageIndex = 0;
  for (const frame of wire.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const event = record(JSON.parse(data));
      const usage =
        record(event?.usage) ??
        record(record(event?.response)?.usage) ??
        record(record(event?.message)?.usage);
      if (!usage) continue;
      if (usageIndex >= result.length) continue;
      const target = result[usageIndex++];
      for (const key of [
        "completion_tokens_details",
        "output_tokens_details",
      ]) {
        const details = record(usage[key]);
        if (!details) continue;
        target[key] = Object.fromEntries(
          ["reasoning_tokens", "thinking_tokens"]
            .filter(
              (field) =>
                typeof details[field] === "number" || details[field] === null,
            )
            .map((field) => [field, details[field]]),
        );
      }
    } catch {
      /* Malformed frames carry no evidence. */
    }
  }
  return result;
}
interface NativeSnapshotEvidence {
  event:
    | "response.output_item.added"
    | "response.output_item.done"
    | "response.completed";
  outputIndex: number;
  itemType: "reasoning" | "message" | "function_call";
  idHash?: string;
  projectionHash: string;
  encrypted: {
    kind: "missing" | "null" | "empty" | "string" | "invalid";
    length?: number;
    hash?: string;
  };
}
interface ChatDetailEvidence {
  choiceIndex?: number;
  type:
    | "reasoning.text"
    | "reasoning.summary"
    | "reasoning.encrypted"
    | "other";
  index: {
    kind: string;
    value?: number;
    canonicalDecimal?: boolean;
    length?: number;
  };
  idHash?: string;
  fields: string[];
  unknownFieldCount: number;
  payloads: Record<string, { kind: string; length?: number; hash?: string }>;
}
export function extractChatDetailEvidence(wire: string): ChatDetailEvidence[] {
  const result: ChatDetailEvidence[] = [];
  for (const frame of wire.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const event = record(JSON.parse(data));
      for (const choice of records(event?.choices)) {
        for (const detail of records(record(choice.delta)?.reasoning_details)) {
          const allowed = [
            "type",
            "index",
            "id",
            "format",
            "text",
            "summary",
            "data",
            "signature",
          ];
          const valueKind = (value: unknown): string =>
            value === null
              ? "null"
              : Array.isArray(value)
                ? "array"
                : typeof value;
          result.push({
            ...(typeof choice.index === "number"
              ? { choiceIndex: choice.index }
              : {}),
            type:
              detail.type === "reasoning.text" ||
              detail.type === "reasoning.summary" ||
              detail.type === "reasoning.encrypted"
                ? detail.type
                : "other",
            index: {
              kind: valueKind(detail.index),
              ...(typeof detail.index === "string"
                ? {
                    length: detail.index.length,
                    canonicalDecimal:
                      /^(0|[1-9][0-9]*)$/.test(detail.index) &&
                      Number.isSafeInteger(Number(detail.index)),
                    ...(/^(0|[1-9][0-9]*)$/.test(detail.index) &&
                    Number.isSafeInteger(Number(detail.index))
                      ? { value: Number(detail.index) }
                      : {}),
                  }
                : {}),
              ...(typeof detail.index === "number" &&
              Number.isFinite(detail.index)
                ? { value: detail.index }
                : {}),
            },
            ...(typeof detail.id === "string"
              ? { idHash: digest(detail.id) }
              : {}),
            fields: Object.keys(detail)
              .filter((key) => allowed.includes(key))
              .sort(),
            unknownFieldCount: Object.keys(detail).filter(
              (key) => !allowed.includes(key),
            ).length,
            payloads: Object.fromEntries(
              ["format", "text", "summary", "data", "signature"]
                .filter((key) => Object.hasOwn(detail, key))
                .map((key) => {
                  const value = detail[key];
                  return [
                    key,
                    {
                      kind: valueKind(value),
                      ...(typeof value === "string"
                        ? { length: value.length, hash: digest(value) }
                        : {}),
                    },
                  ];
                }),
            ),
          });
        }
      }
    } catch {
      /* No private values are retained from malformed frames. */
    }
  }
  return result;
}
export function extractNativeSnapshotEvidence(
  wire: string,
): NativeSnapshotEvidence[] {
  const snapshots: NativeSnapshotEvidence[] = [];
  for (const frame of wire.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const event = record(JSON.parse(data));
      if (
        !event ||
        (event.type !== "response.output_item.added" &&
          event.type !== "response.output_item.done" &&
          event.type !== "response.completed")
      )
        continue;
      const items =
        event.type === "response.completed"
          ? records(record(event.response)?.output)
          : records([event.item]);
      for (const [index, item] of items.entries()) {
        if (
          item.type !== "reasoning" &&
          item.type !== "message" &&
          item.type !== "function_call"
        )
          continue;
        const cipher = item.encrypted_content;
        const projection = Object.fromEntries(
          Object.entries(item).filter(
            ([key]) => key !== "encrypted_content" && key !== "status",
          ),
        );
        snapshots.push({
          event: event.type,
          outputIndex:
            typeof event.output_index === "number" ? event.output_index : index,
          itemType: item.type,
          ...(typeof item.id === "string" ? { idHash: digest(item.id) } : {}),
          projectionHash: digest(projection),
          encrypted:
            cipher === undefined
              ? { kind: "missing" }
              : cipher === null
                ? { kind: "null" }
                : typeof cipher === "string"
                  ? {
                      kind: cipher.length ? "string" : "empty",
                      length: cipher.length,
                      hash: digest(cipher),
                    }
                  : { kind: "invalid" },
        });
      }
    } catch {
      /* Incomplete or invalid frames have no safe snapshot evidence. */
    }
  }
  return snapshots;
}
async function captureResponseEvidence(
  response: Response,
  capture: WireCapture,
): Promise<void> {
  capture.rawUsage = [];
  capture.nativeSnapshots = [];
  capture.chatDetails = [];
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let pending = "";
  const accept = (frame: string): void => {
    capture.rawUsage?.push(...extractNativeUsageEvidence(frame));
    capture.nativeSnapshots?.push(...extractNativeSnapshotEvidence(frame));
    capture.chatDetails?.push(...extractChatDetailEvidence(frame));
    capture.errorCode ??= extractCacheErrorCode(frame);
  };
  try {
    for (
      let chunk = await reader.read();
      !chunk.done;
      chunk = await reader.read()
    ) {
      const value: unknown = chunk.value;
      check(value instanceof Uint8Array, "INVALID_CAPTURE_CHUNK");
      pending += decoder.decode(value, { stream: true });
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() ?? "";
      for (const frame of frames) accept(frame);
    }
    pending += decoder.decode();
  } catch {
    capture.captureInterrupted = true;
  } finally {
    // Completed frames survive the SDK aborting after a protocol error.
    if (pending) accept(pending);
    reader.releaseLock();
  }
}
function controls(body: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    "model",
    "reasoning",
    "reasoning_effort",
    "thinking",
    "output_config",
    "temperature",
    "max_tokens",
    "max_output_tokens",
    "store",
  ];
  return Object.fromEntries(
    keys
      .filter((key) => body[key] !== undefined)
      .map((key) => [key, body[key]]),
  );
}
function hasToolRoundTrip(
  body: Record<string, unknown>,
  protocol: InterfaceProviderKind,
  callId: string,
): boolean {
  if (protocol === "openai-responses") {
    const items = records(body.input);
    return (
      items.filter(
        (item) => item.type === "function_call" && item.call_id === callId,
      ).length === 1 &&
      items.filter(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === callId &&
          item.output === NATIVE_PROBE_RESULT,
      ).length === 1
    );
  }
  const messages = records(body.messages);
  if (protocol === "anthropic") {
    const blocks = messages.flatMap((message) => records(message.content));
    return (
      blocks.filter((block) => block.type === "tool_use" && block.id === callId)
        .length === 1 &&
      blocks.filter(
        (block) =>
          block.type === "tool_result" &&
          block.tool_use_id === callId &&
          block.content === NATIVE_PROBE_RESULT,
      ).length === 1
    );
  }
  return (
    messages
      .flatMap((message) => records(message.tool_calls))
      .filter((call) => call.id === callId).length === 1 &&
    messages.filter(
      (message) =>
        message.role === "tool" &&
        message.tool_call_id === callId &&
        message.content === NATIVE_PROBE_RESULT,
    ).length === 1
  );
}
function reconcileRawUsage(
  raw: Record<string, unknown>[],
  protocol: InterfaceProviderKind,
  accepted: InterfaceProviderTokenUsage,
): void {
  const inputRows =
    protocol === "anthropic"
      ? raw.filter(
          (row, index) =>
            !(
              [
                "input_tokens",
                "cache_read_input_tokens",
                "cache_creation_input_tokens",
              ].every((key) => row[key] === 0) &&
              raw
                .slice(0, index)
                .some((previous) =>
                  [
                    "input_tokens",
                    "cache_read_input_tokens",
                    "cache_creation_input_tokens",
                  ].some(
                    (key) =>
                      typeof previous[key] === "number" && previous[key] > 0,
                  ),
                )
            ),
        )
      : raw;
  const last = (
    key: string,
    parent?: string,
    rows = inputRows,
  ): number | undefined => {
    const values = rows.flatMap((row) => {
      const value = parent ? record(row[parent])?.[key] : row[key];
      return typeof value === "number" && Number.isInteger(value) && value >= 0
        ? [value]
        : [];
    });
    return values.length ? values[values.length - 1] : undefined;
  };
  const hit = last("prompt_cache_hit_tokens");
  const miss = last("prompt_cache_miss_tokens");
  const details =
    protocol === "openai-responses"
      ? "input_tokens_details"
      : "prompt_tokens_details";
  const read =
    protocol === "anthropic"
      ? last("cache_read_input_tokens")
      : hit !== undefined || miss !== undefined
        ? hit
        : last("cached_tokens", details);
  const write =
    protocol === "anthropic"
      ? last("cache_creation_input_tokens")
      : hit !== undefined || miss !== undefined
        ? undefined
        : last("cache_write_tokens", details);
  const uncached = last("input_tokens");
  const input =
    protocol === "anthropic"
      ? uncached === undefined
        ? undefined
        : uncached + (read ?? 0) + (write ?? 0)
      : protocol === "openai-responses"
        ? last("input_tokens")
        : (last("prompt_tokens") ??
          (hit !== undefined && miss !== undefined ? hit + miss : undefined));
  const output = last(
    protocol === "openai-compatible" ? "completion_tokens" : "output_tokens",
    undefined,
    raw,
  );
  check(
    input === accepted.inputTokens &&
      output === accepted.outputTokens &&
      accepted.totalTokens === input + output,
    "RAW_ACCEPTED_USAGE_MISMATCH",
  );
  check(
    (accepted.inputBreakdown?.observed.cacheRead ?? false) ===
      (read !== undefined),
    "RAW_CACHE_READ_AVAILABILITY_MISMATCH",
  );
  if (read !== undefined)
    check(
      accepted.inputBreakdown?.cacheRead === read,
      "RAW_CACHE_READ_VALUE_MISMATCH",
    );
  if (write !== undefined)
    check(
      accepted.inputBreakdown?.cacheWrite === write,
      "RAW_CACHE_WRITE_VALUE_MISMATCH",
    );
}
interface WireCapture {
  readonly body: Record<string, unknown>;
  readonly mode: "on" | "off";
  readonly path: string;
  status?: number;
  errorCode?: string | number;
  rawUsage?: Record<string, unknown>[];
  nativeSnapshots?: NativeSnapshotEvidence[];
  chatDetails?: ChatDetailEvidence[];
  captureInterrupted?: boolean;
}
interface SafeFailureDetails {
  readonly name: string;
  readonly status?: number;
  readonly reason?: string;
  readonly locations: string[];
}
function failureDetails(error: unknown, apiKey: string): SafeFailureDetails {
  const object = record(error);
  const status = typeof object?.status === "number" ? object.status : undefined;
  const name = error instanceof Error ? error.name : "UnknownFailure";
  const message = error instanceof Error ? error.message : "";
  const owned =
    /^(Responses |Anthropic |Chat |Native state |Conflicting (?:Anthropic|Chat) |Invalid (?:Anthropic|Chat) |Unsupported (?:Anthropic|Chat) |Incomplete (?:Anthropic|Chat) )/.test(
      message,
    );
  const reason = owned
    ? message
        .split(apiKey)
        .join("[redacted]")
        .replace(/[A-Za-z0-9+/=_-]{48,}/g, "[redacted]")
        .slice(0, 300)
    : undefined;
  const locations =
    error instanceof Error
      ? (
          error.stack?.match(
            /(?:interface-providers|core\/[^/]+)\/[a-z-]+\.ts:\d+:\d+/g,
          ) ?? []
        ).slice(0, 4)
      : [];
  return { name, status, reason, locations };
}
export interface NativeModeEvidence {
  readonly mode: "on" | "off";
  readonly requestedEffort: string;
  acceptedSteps: InterfaceProviderTokenUsage[];
  toolExecutions: number;
  persistedNative: NativeFingerprint[];
  stateEstimate?: { tokens: number; source: string };
  nativeReplayed: boolean;
  runtimePassed?: boolean;
  disabledEffect?: "zero_observed" | "reasoning_observed" | "unknown";
  databaseReopened: boolean;
  restoredTrackerEmpty: boolean;
  cacheBeforeReopen?: ReturnType<
    ReturnType<typeof createPromptCacheUsageTracker>["get"]
  >;
  cacheAfterReopen?: ReturnType<
    ReturnType<typeof createPromptCacheUsageTracker>["get"]
  >;
  passed: boolean;
  failure?: string;
  failureDetails?: SafeFailureDetails;
}
export interface NativeProfileEvidence {
  readonly profile: string;
  readonly model: string;
  readonly protocol: InterfaceProviderKind;
  readonly transport: "fake" | "real";
  readonly limits: Omit<typeof NATIVE_REAL_LIMITS, "maxRequests"> & {
    readonly maxRequests: number;
  };
  readonly runKind: "matrix" | "diagnostic";
  readonly capabilitySources: readonly string[];
  readonly observedAt: string;
  modes: NativeModeEvidence[];
  requests: {
    mode: "on" | "off";
    path: string;
    status?: number;
    errorCode?: string | number;
    controls: Record<string, unknown>;
    rawUsage?: Record<string, unknown>[];
    nativeSnapshots?: NativeSnapshotEvidence[];
    chatDetails?: ChatDetailEvidence[];
    captureInterrupted?: boolean;
    nativeReplay: NativeFingerprint[];
  }[];
  actualHttpRequests: number;
  testAcceptedUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  testKnownCache?: {
    accountedInputTokens: number;
    cacheReadTokens: number;
    cacheReadShare: number | null;
  };
  passed: boolean;
}
export async function runNativeProfile(
  profile: NativeRealProfile,
  options: { apiKey: string; transport?: typeof fetch; requestLimit?: 1 | 4 },
): Promise<NativeProfileEvidence> {
  const report: NativeProfileEvidence = {
    profile: profile.id,
    model: profile.model,
    protocol: profile.protocol,
    transport: options.transport ? "fake" : "real",
    limits: { ...NATIVE_REAL_LIMITS, maxRequests: options.requestLimit ?? 4 },
    runKind: options.requestLimit === 1 ? "diagnostic" : "matrix",
    capabilitySources: profile.sources,
    observedAt: new Date().toISOString(),
    modes: [],
    requests: [],
    actualHttpRequests: 0,
    passed: false,
  };
  const workdir = await mkdtemp(join(tmpdir(), "ohbaby-reasoning-e2e-"));
  const databasePath = join(workdir, "agent.db");
  const captured: WireCapture[] = [];
  const reads: Promise<void>[] = [];
  const originalFetch = globalThis.fetch;
  const transport = options.transport ?? originalFetch;
  let currentMode: "on" | "off" = "on";
  let stopped = false;
  globalThis.fetch = async (input, init): Promise<Response> => {
    check(!stopped, "PROFILE_STOPPED");
    check(
      captured.length < report.limits.maxRequests,
      "PROFILE_HTTP_BUDGET_EXHAUSTED",
    );
    const raw =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : "{}";
    const body = record(JSON.parse(raw));
    check(body, "INVALID_SDK_REQUEST_BODY");
    const url = new URL(input instanceof Request ? input.url : String(input));
    const capture: WireCapture = {
      body,
      mode: currentMode,
      path: url.pathname,
    };
    captured.push(capture);
    try {
      const parentSignal =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const timeout = AbortSignal.timeout(NATIVE_REAL_LIMITS.requestTimeoutMs);
      const response = await transport(input, {
        ...init,
        signal: parentSignal
          ? AbortSignal.any([parentSignal, timeout])
          : timeout,
      });
      capture.status = response.status;
      if (!response.ok) stopped = true;
      reads.push(captureResponseEvidence(response.clone(), capture));
      return response;
    } catch (error) {
      stopped = true;
      throw error;
    }
  };
  try {
    initDatabase({ dbPath: databasePath });
    for (const enabled of [true, false]) {
      if (stopped) break;
      currentMode = enabled ? "on" : "off";
      const sessionId = `native-${randomUUID()}`;
      const mode: NativeModeEvidence = {
        mode: currentMode,
        requestedEffort: profile.enabledEffort,
        acceptedSteps: [],
        toolExecutions: 0,
        persistedNative: [],
        nativeReplayed: false,
        databaseReopened: false,
        restoredTrackerEmpty: false,
        passed: false,
      };
      report.modes.push(mode);
      const firstRequestIndex = captured.length;
      getDatabase()
        .prepare(
          `INSERT INTO ${schema.session.tableName} (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          "native-probe",
          workdir,
          "build",
          "Synthetic native reasoning E2E",
          "active",
          Date.now(),
          Date.now(),
          0,
          "{}",
        );
      let tracker = createPromptCacheUsageTracker();
      const provider = createInterfaceProvider({
        id: "zenmux",
        interfaceProvider: profile.protocol,
        baseUrl: profile.baseUrl,
        apiKey: options.apiKey,
      });
      Reflect.set(
        provider.client as object,
        "maxRetries",
        NATIVE_REAL_LIMITS.sdkRetries,
      );
      const client: LLMClientInstance = {
        provider,
        config: {
          provider: "zenmux",
          model: profile.model,
          interfaceProvider: profile.protocol,
          baseUrl: profile.baseUrl,
          maxTokens: NATIVE_REAL_LIMITS.maxTokens,
          promptCache: "auto",
          reasoning: { enabled, effort: profile.enabledEffort },
          modelProfiles: [
            {
              provider: "zenmux",
              model: profile.model,
              interfaceProvider: profile.protocol,
              baseUrl: profile.baseUrl,
              contextWindowTokens: 100000,
              reasoningCapabilities: profile.capabilities,
            },
          ],
        },
      };
      const build = (): {
        messages: ReturnType<typeof createMessageManager>;
        scheduler: ReturnType<typeof createToolScheduler>;
        lifecycle: Lifecycle;
      } => {
        const bus = createBus();
        const messages = createMessageManager({
          bus,
          store: createDatabaseMessageStore(),
        });
        const scheduler = createToolScheduler({
          bus,
          permission: { ask: () => "once" },
          permissionState: createPermissionState({
            bus,
            initialLevel: "full-access",
          }),
        });
        scheduler.register({
          name: NATIVE_PROBE_TOOL,
          source: "builtin",
          category: "readonly",
          description:
            "Returns a synthetic verification marker; call exactly once with no arguments.",
          parametersJsonSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          execute: () => {
            mode.toolExecutions += 1;
            return { output: NATIVE_PROBE_RESULT };
          },
        });
        const context = createContextManager({
          bus,
          messageManager: messages,
          memory: {
            load: () =>
              Promise.resolve({ global: "", project: "", merged: "" }),
          },
          systemPromptProvider: {
            build: () =>
              Promise.resolve(
                "Follow the synthetic verification request. Use only the explicitly requested tool, once. Preserve the exact tool result for the final answer.",
              ),
          },
          tokenCounter: {
            estimateTokens: (content) => Math.ceil(content.length / 4),
            getLimit: () => 100000,
          },
          llmClient: {
            generateSummary: () =>
              Promise.reject(new Error("UNEXPECTED_COMPACTION_REQUEST")),
          },
        });
        return {
          messages,
          scheduler,
          lifecycle: new Lifecycle({
            messageManager: messages,
            contextManager: context,
            toolScheduler: scheduler,
            llmClient: client,
          }),
        };
      };
      let runtime = build();
      const executionCount = (): number => mode.toolExecutions;
      const environment: ToolExecutionEnvironment = {
        workdir,
        resolvePath: (path) => join(workdir, path),
        resolvePathForExisting: (path) => Promise.resolve(join(workdir, path)),
        resolvePathForWrite: (path) => Promise.resolve(join(workdir, path)),
        resolveCommandContext: () => ({ cwd: workdir, kind: "host-local" }),
      };
      const run = async (
        prompt: string,
        stopAfterTool: boolean,
      ): Promise<LifecycleResult> => {
        const user = await runtime.messages.createMessage({
          agent: "build",
          role: "user",
          sessionId,
        });
        await runtime.messages.appendPart(user.id, {
          type: "text",
          text: prompt,
        });
        const loop = runtime.lifecycle.run(
          {
            agent: "build",
            directory: workdir,
            environment,
            initiatingUserMessageId: user.id,
            maxSteps: 2,
            modelId: profile.model,
            sessionId,
            signal: AbortSignal.timeout(100000),
            tools: toModelTools(await runtime.scheduler.getAvailableTools()),
            onStepUsage: (observation) => {
              if (observation.tokenUsage)
                mode.acceptedSteps.push(observation.tokenUsage);
              tracker.record(sessionId, observation.tokenUsage);
            },
          },
          {
            shouldStopAfterTurn: (turn) =>
              stopAfterTool && (turn.toolResults?.length ?? 0) > 0,
          },
        );
        let next = await loop.next();
        while (!next.done) next = await loop.next();
        return next.value;
      };
      try {
        const first = await run(
          `This is a synthetic tool-continuation test. Before acting, check the consistency of these constraints: A before C, B after A, D before B, C after D. Then call ${NATIVE_PROBE_TOOL} exactly once with no arguments. After receiving its result, reply with exactly that result.`,
          true,
        );
        if (!first.success)
          mode.failureDetails = failureDetails(
            first.failureCause,
            options.apiKey,
          );
        check(
          first.success &&
            first.finishReason === "tool_calls" &&
            executionCount() === 1,
          "INITIAL_TOOL_STEP_INCOMPLETE",
        );
        const history = await runtime.messages.listBySession(sessionId);
        const assistant = history.find(
          (message) => message.info.role === "assistant",
        );
        check(assistant, "ASSISTANT_NOT_PERSISTED");
        const state = assistant.parts.find(
          (part) => part.type === "model-state",
        );
        mode.stateEstimate =
          state?.type === "model-state" ? state.modelState.estimate : undefined;
        mode.persistedNative = fingerprints(
          nativeItems(
            state?.type === "model-state" ? state.modelState.output : undefined,
          ),
        );
        const tool = assistant.parts.find((part) => part.type === "tool");
        check(
          tool?.type === "tool" && tool.state.status === "completed",
          "TOOL_NOT_PERSISTED_COMPLETE",
        );
        const callId = tool.callId;
        check(
          assistant.parts.filter(
            (part) => readTokenUsageMetadata(part.metadata) !== undefined,
          ).length === 1,
          "STEP_USAGE_CARRIER_MISMATCH",
        );
        mode.cacheBeforeReopen = tracker.get(sessionId);
        closeDatabase();
        initDatabase({ dbPath: databasePath });
        tracker = createPromptCacheUsageTracker();
        mode.restoredTrackerEmpty =
          tracker.get(sessionId).accountedInputTokens === 0;
        runtime = build();
        const restored = await runtime.messages.listBySession(sessionId);
        check(
          digest(restored) === digest(history),
          "SQLITE_REOPEN_CHANGED_HISTORY",
        );
        mode.databaseReopened = true;
        const second = await run(
          "Continue the completed tool exchange from the previous Run. Do not call tools again. Reply with exactly the tool result already in the conversation.",
          false,
        );
        if (!second.success)
          mode.failureDetails = failureDetails(
            second.failureCause,
            options.apiKey,
          );
        check(
          second.success &&
            second.finishReason === "stop" &&
            second.finalResponse.trim() === NATIVE_PROBE_RESULT &&
            executionCount() === 1,
          "CONTINUATION_INCOMPLETE",
        );
        const continuation = captured[firstRequestIndex + 1];
        check(
          captured.length > firstRequestIndex + 1 &&
            hasToolRoundTrip(continuation.body, profile.protocol, callId),
          "TOOL_WIRE_CORRELATION_MISMATCH",
        );
        const replayed = fingerprints(
          outgoingNative(continuation.body, profile.protocol),
        );
        mode.nativeReplayed =
          mode.persistedNative.length > 0 &&
          mode.persistedNative.every((item) =>
            replayed.some((candidate) => candidate.sha256 === item.sha256),
          );
        check(mode.acceptedSteps.length === 2, "ACCEPTED_STEP_COUNT_MISMATCH");
        for (const usage of mode.acceptedSteps)
          check(
            usage.inputTokens > 0 &&
              usage.outputTokens > 0 &&
              usage.totalTokens === usage.inputTokens + usage.outputTokens,
            "ACCEPTED_USAGE_INVALID",
          );
        const after = await runtime.messages.listBySession(sessionId);
        const persisted = after
          .filter((message) => message.info.role === "assistant")
          .map((message) =>
            message.parts.flatMap((part) => {
              const usage = readTokenUsageMetadata(part.metadata);
              return usage ? [usage] : [];
            }),
          );
        check(
          persisted.length === 2 &&
            persisted.every(
              (items, index) =>
                items.length === 1 &&
                digest(items[0]) === digest(mode.acceptedSteps[index]),
            ),
          "PERSISTED_USAGE_MISMATCH",
        );
        mode.cacheAfterReopen = tracker.get(sessionId);
        const last = mode.acceptedSteps[1];
        const known = last.inputBreakdown?.observed.cacheRead === true;
        check(
          mode.cacheAfterReopen.accountedInputTokens ===
            (known ? last.inputTokens : 0),
          "TRACKER_REOPEN_INPUT_MISMATCH",
        );
        check(
          mode.cacheAfterReopen.cacheReadTokens ===
            (known ? last.inputBreakdown.cacheRead : 0),
          "TRACKER_REOPEN_READ_MISMATCH",
        );
        await Promise.all(reads);
        for (const [index, accepted] of mode.acceptedSteps.entries()) {
          reconcileRawUsage(
            captured[firstRequestIndex + index].rawUsage ?? [],
            profile.protocol,
            accepted,
          );
        }
        if (enabled)
          check(
            mode.nativeReplayed,
            "TARGET_NATIVE_REASONING_COVERAGE_MISSING",
          );
        mode.runtimePassed = true;
        if (!enabled) {
          const modeCaptures = captured.slice(firstRequestIndex);
          const rawReasoning = modeCaptures.flatMap((capture) =>
            (capture.rawUsage ?? []).flatMap((usage) =>
              [
                record(usage.completion_tokens_details)?.reasoning_tokens,
                record(usage.output_tokens_details)?.reasoning_tokens,
                record(usage.output_tokens_details)?.thinking_tokens,
              ].filter((value): value is number => typeof value === "number"),
            ),
          );
          const nativeObserved =
            mode.persistedNative.length > 0 ||
            modeCaptures.some(
              (capture) =>
                (capture.chatDetails?.length ?? 0) > 0 ||
                capture.nativeSnapshots?.some(
                  (item) => item.itemType === "reasoning",
                ),
            );
          mode.disabledEffect =
            nativeObserved || rawReasoning.some((value) => value > 0)
              ? "reasoning_observed"
              : rawReasoning.length
                ? "zero_observed"
                : "unknown";
          check(
            mode.disabledEffect !== "reasoning_observed",
            "DISABLED_REASONING_SEMANTICS_NOT_OBSERVED",
          );
        }
        mode.passed = true;
      } catch (error) {
        mode.failureDetails ??= failureDetails(error, options.apiKey);
        mode.failure =
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : `RUNTIME_${error instanceof Error ? error.name : "UNKNOWN"}`;
        stopped = mode.failure !== "TARGET_NATIVE_REASONING_COVERAGE_MISSING";
      }
    }
    report.passed =
      report.modes.length === 2 && report.modes.every((mode) => mode.passed);
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.all(reads);
    const accepted = report.modes.flatMap((mode) => mode.acceptedSteps);
    report.testAcceptedUsage = accepted.reduce(
      (sum, usage) => ({
        inputTokens: sum.inputTokens + usage.inputTokens,
        outputTokens: sum.outputTokens + usage.outputTokens,
        totalTokens: sum.totalTokens + usage.totalTokens,
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    );
    const known = accepted.filter(
      (usage) => usage.inputBreakdown?.observed.cacheRead === true,
    );
    const accountedInputTokens = known.reduce(
      (sum, usage) => sum + usage.inputTokens,
      0,
    );
    const cacheReadTokens = known.reduce(
      (sum, usage) => sum + (usage.inputBreakdown?.cacheRead ?? 0),
      0,
    );
    report.testKnownCache = {
      accountedInputTokens,
      cacheReadTokens,
      cacheReadShare:
        accountedInputTokens === 0
          ? null
          : cacheReadTokens / accountedInputTokens,
    };
    report.actualHttpRequests = captured.length;
    report.requests = captured.map((item) => ({
      mode: item.mode,
      path: item.path,
      status: item.status,
      errorCode: item.errorCode,
      controls: controls(item.body),
      rawUsage: item.rawUsage,
      nativeSnapshots: item.nativeSnapshots,
      chatDetails: item.chatDetails,
      captureInterrupted: item.captureInterrupted,
      nativeReplay: fingerprints(outgoingNative(item.body, profile.protocol)),
    }));
    closeDatabase();
    await rm(workdir, { recursive: true, force: true });
  }
  return report;
}
