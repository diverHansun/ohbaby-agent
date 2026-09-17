import { createHash } from "node:crypto";
import { summarizeWire } from "./agent-loop-observer.js";
import { extractCacheUsageEvidence } from "./responses-cache-evidence.js";

type JsonRecord = Record<string, unknown>;
export interface CacheDigest {
  sha256: string;
  bytes: number;
}
interface FormalCacheEvidenceBase {
  sequence: number;
  context?: { purpose?: string; id?: number };
  path: string;
  status?: number;
  captureError?: "request_body" | "response_stream" | "transport";
}
export interface FormalCacheMetadataEvidence extends FormalCacheEvidenceBase {
  kind: "metadata";
}
export interface FormalCacheGenerationEvidence extends FormalCacheEvidenceBase {
  kind: "generation";
  protocol: "openai-compatible" | "openai-responses" | "anthropic";
  model?: string;
  reasoning: JsonRecord;
  encryptedReasoningRequested?: boolean;
  toolPairing?: FormalToolPairing;
  nativeInputCount?: number;
  system: CacheDigest;
  tools: CacheDigest;
  input: CacheDigest;
  inputCount: number;
  inputPrefixes: CacheDigest[];
  prefixBeforeLatestUser?: CacheDigest;
  rawUsage: JsonRecord[];
  finalUsage: JsonRecord;
}
export type FormalCacheRequestEvidence =
  | FormalCacheMetadataEvidence
  | FormalCacheGenerationEvidence;

export interface FormalToolPairing {
  calls: string[];
  results: string[];
  invalidIds: number;
  duplicateCalls: number;
  duplicateResults: number;
  resultsBeforeCalls: number;
  unmatchedResults: number;
  unansweredCalls: number;
}

const pairingFailures = [
  "invalidIds",
  "duplicateCalls",
  "duplicateResults",
  "resultsBeforeCalls",
  "unmatchedResults",
  "unansweredCalls",
] as const;

export function hasValidFormalToolPairing(
  pairing: FormalToolPairing | undefined,
): boolean {
  return (
    pairing !== undefined && pairingFailures.every((key) => pairing[key] === 0)
  );
}

export function auditFormalToolExchange(
  rows: readonly FormalCacheGenerationEvidence[],
): {
  exercised: boolean;
  valid: boolean;
  pairedRequestSequences: number[];
} {
  const pairedRequestSequences = rows
    .filter(
      (row) =>
        (row.toolPairing?.calls.length ?? 0) > 0 &&
        (row.toolPairing?.results.length ?? 0) > 0,
    )
    .map((row) => row.sequence);
  return {
    exercised: pairedRequestSequences.length > 0,
    valid:
      pairedRequestSequences.length > 0 &&
      rows.every((row) => hasValidFormalToolPairing(row.toolPairing)),
    pairedRequestSequences,
  };
}

export function auditFormalNativeReplay(
  expected: readonly string[],
  actual: readonly string[] | undefined,
): {
  exercised: boolean;
  valid: boolean;
  expected: string[];
  actual: string[];
} {
  const before = [...expected].sort(),
    after = [...(actual ?? [])].sort();
  return {
    exercised: before.length > 0,
    valid:
      before.length === 0 ||
      (actual !== undefined &&
        JSON.stringify(before) === JSON.stringify(after)),
    expected: before,
    actual: after,
  };
}

/** Inspect raw IDs only in memory; retain hashes and numeric verdicts. */
function toolPairingEvidence(body: JsonRecord): FormalToolPairing {
  const events: { kind: "call" | "result"; id: unknown }[] = [];
  const rows = Array.isArray(body.input)
    ? body.input
    : Array.isArray(body.messages)
      ? body.messages
      : [];
  for (const raw of rows) {
    const row = record(raw);
    if (!row) continue;
    if (row.type === "function_call")
      events.push({ kind: "call", id: row.call_id });
    if (row.type === "function_call_output")
      events.push({ kind: "result", id: row.call_id });
    if (Array.isArray(row.tool_calls))
      for (const call of row.tool_calls)
        events.push({ kind: "call", id: record(call)?.id });
    if (row.role === "tool")
      events.push({ kind: "result", id: row.tool_call_id });
    if (Array.isArray(row.content))
      for (const rawPart of row.content) {
        const part = record(rawPart);
        if (part?.type === "tool_use")
          events.push({ kind: "call", id: part.id });
        if (part?.type === "tool_result")
          events.push({ kind: "result", id: part.tool_use_id });
      }
  }
  const audit: FormalToolPairing = {
    calls: [],
    results: [],
    invalidIds: 0,
    duplicateCalls: 0,
    duplicateResults: 0,
    resultsBeforeCalls: 0,
    unmatchedResults: 0,
    unansweredCalls: 0,
  };
  const calls = new Map<string, number>(),
    results = new Map<string, number>();
  for (const event of events) {
    if (typeof event.id !== "string" || event.id.trim().length === 0) {
      audit.invalidIds++;
      continue;
    }
    const hash = createHash("sha256").update(event.id).digest("hex");
    if (event.kind === "call") {
      audit.calls.push(hash);
      calls.set(hash, (calls.get(hash) ?? 0) + 1);
    } else {
      audit.results.push(hash);
      results.set(hash, (results.get(hash) ?? 0) + 1);
      if (!calls.has(hash)) audit.resultsBeforeCalls++;
    }
  }
  audit.duplicateCalls = [...calls.values()].reduce(
    (sum, n) => sum + Math.max(0, n - 1),
    0,
  );
  audit.duplicateResults = [...results.values()].reduce(
    (sum, n) => sum + Math.max(0, n - 1),
    0,
  );
  audit.unmatchedResults = [...results.keys()].filter(
    (id) => !calls.has(id),
  ).length;
  audit.unansweredCalls = [...calls.keys()].filter(
    (id) => !results.has(id),
  ).length;
  return audit;
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/** Object key order is canonical; array order and every native input value remain significant. */
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

function digest(value: unknown): CacheDigest {
  const serialized = canonical(value);
  return {
    sha256: createHash("sha256").update(serialized).digest("hex"),
    bytes: Buffer.byteLength(serialized),
  };
}

function safeReasoning(body: JsonRecord): JsonRecord {
  const result: JsonRecord = {
    controlFields: [
      "reasoning",
      "reasoning_effort",
      "thinking",
      "output_config",
    ].filter((key) => body[key] !== undefined),
  };
  const reasoning = record(body.reasoning);
  const thinking = record(body.thinking);
  const outputConfig = record(body.output_config);
  for (const [key, value, allowed] of [
    [
      "effort",
      reasoning?.effort ?? body.reasoning_effort ?? outputConfig?.effort,
      ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    ],
    ["summary", reasoning?.summary, ["auto", "concise", "detailed", "none"]],
    ["thinkingType", thinking?.type, ["enabled", "disabled", "adaptive"]],
  ] as const) {
    if (
      typeof value === "string" &&
      (allowed as readonly string[]).includes(value)
    )
      result[key] = value;
  }
  if (
    typeof thinking?.budget_tokens === "number" &&
    Number.isFinite(thinking.budget_tokens)
  )
    result.budgetTokens = thinking.budget_tokens;
  // Digest unknown configuration as well, without persisting arbitrary provider values.
  result.config = digest({
    reasoning: body.reasoning ?? null,
    reasoning_effort: body.reasoning_effort ?? null,
    thinking: body.thinking ?? null,
    output_config: body.output_config ?? null,
  });
  return result;
}

function requestEvidence(
  body: JsonRecord,
): Pick<
  FormalCacheGenerationEvidence,
  | "model"
  | "reasoning"
  | "encryptedReasoningRequested"
  | "toolPairing"
  | "nativeInputCount"
  | "system"
  | "tools"
  | "input"
  | "inputCount"
  | "inputPrefixes"
  | "prefixBeforeLatestUser"
> {
  const input = Array.isArray(body.input)
    ? body.input
    : Array.isArray(body.messages)
      ? body.messages
      : typeof body.input === "string"
        ? [body.input]
        : [];
  const systemMessages = input.filter((item) =>
    ["system", "developer"].includes(String(record(item)?.role)),
  );
  const latestUser = input.findLastIndex(
    (item) => record(item)?.role === "user",
  );
  const pairing = summarizeWire(body);
  return {
    encryptedReasoningRequested:
      Array.isArray(body.include) &&
      body.include.includes("reasoning.encrypted_content"),
    toolPairing: toolPairingEvidence(body),
    nativeInputCount:
      pairing.nativeTypes.length +
      input.filter((item) => {
        const row = record(item);
        return (
          row?.role === "assistant" &&
          (typeof row.reasoning_content === "string" ||
            typeof row.reasoning === "string")
        );
      }).length,
    ...(typeof body.model === "string" &&
    /^[a-zA-Z0-9/_.:-]{1,160}$/.test(body.model)
      ? { model: body.model }
      : {}),
    reasoning: safeReasoning(body),
    system: digest({
      instructions: body.instructions ?? null,
      system: body.system ?? null,
      messages: systemMessages,
    }),
    tools: digest(body.tools ?? []),
    input: digest(input),
    inputCount: input.length,
    inputPrefixes: input.map((_, index) => digest(input.slice(0, index + 1))),
    ...(latestUser >= 0
      ? { prefixBeforeLatestUser: digest(input.slice(0, latestUser)) }
      : {}),
  };
}

function mergeUsage(frames: JsonRecord[]): JsonRecord {
  const final: JsonRecord = {};
  for (const frame of frames) {
    for (const [key, value] of Object.entries(frame)) {
      const details = record(value);
      final[key] =
        details && key.endsWith("_details")
          ? { ...record(final[key]), ...details }
          : value;
    }
  }
  return final;
}

/**
 * Installs a test-only guard/observer around the existing transport. It never initiates
 * requests and forwards the caller's arguments unchanged. Only a response clone is read.
 * Call drain after application work settles, then restore in a finally block.
 */
export function installFormalCacheObserver(
  options: {
    maxRequests?: number;
    context?: () => { purpose?: string; id?: number } | undefined;
  } = {},
): {
  records: FormalCacheRequestEvidence[];
  drain: () => Promise<void>;
  restore: () => void;
} {
  const maxRequests = options.maxRequests ?? 25;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 25)
    throw new Error("FORMAL_CACHE_INVALID_REQUEST_LIMIT");
  const originalFetch = globalThis.fetch;
  const records: FormalCacheRequestEvidence[] = [];
  const pending = new Set<Promise<void>>();
  let count = 0;
  const observedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const metadata =
      method === "GET" &&
      ["/api/v1/models", "/api/anthropic/v1/models"].includes(url.pathname);
    const protocol =
      url.pathname === "/api/v1/chat/completions"
        ? "openai-compatible"
        : url.pathname === "/api/v1/responses"
          ? "openai-responses"
          : url.pathname === "/api/anthropic/v1/messages"
            ? "anthropic"
            : undefined;
    if (
      url.protocol !== "https:" ||
      url.hostname !== "zenmux.ai" ||
      url.port ||
      url.username ||
      url.password ||
      (!protocol && !metadata)
    )
      throw new Error("FORMAL_CACHE_NETWORK_DENIED");
    if (count >= maxRequests) throw new Error("FORMAL_CACHE_REQUEST_LIMIT");
    const sequence = ++count;
    const context = options.context?.();
    const common: FormalCacheEvidenceBase = {
      sequence,
      ...(context
        ? {
            context: {
              ...(typeof context.purpose === "string" &&
              /^[a-zA-Z0-9_.:-]{1,80}$/.test(context.purpose)
                ? { purpose: context.purpose }
                : {}),
              ...(typeof context.id === "number" &&
              Number.isSafeInteger(context.id)
                ? { id: context.id }
                : {}),
            },
          }
        : {}),
      path: url.pathname,
    };
    const evidence: FormalCacheRequestEvidence = protocol
      ? {
          ...common,
          kind: "generation",
          protocol,
          ...requestEvidence({}),
          rawUsage: [],
          finalUsage: {},
        }
      : { ...common, kind: "metadata" };
    records.push(evidence);
    // Reserve before the first await: drain also waits for requests awaiting headers.
    let complete!: () => void;
    const settled = new Promise<void>((resolve) => {
      complete = resolve;
    });
    pending.add(settled);
    void settled.finally(() => pending.delete(settled));
    if (evidence.kind === "generation")
      try {
        const raw =
          typeof init?.body === "string"
            ? init.body
            : input instanceof Request && init?.body === undefined
              ? await input.clone().text()
              : undefined;
        const body = raw === undefined ? undefined : record(JSON.parse(raw));
        if (body) Object.assign(evidence, requestEvidence(body));
        else evidence.captureError = "request_body";
      } catch {
        evidence.captureError = "request_body";
      }
    try {
      const response = await originalFetch(input, init);
      evidence.status = response.status;
      if (evidence.kind === "metadata") {
        complete();
        return response;
      }
      try {
        const read = response
          .clone()
          .text()
          .then((wire) => {
            evidence.rawUsage = extractCacheUsageEvidence(wire);
            evidence.finalUsage = mergeUsage(evidence.rawUsage);
          })
          .catch(() => {
            evidence.captureError = "response_stream";
          });
        void read.finally(complete);
      } catch {
        evidence.captureError = "response_stream";
        complete();
      }
      return response;
    } catch (error) {
      evidence.captureError = "transport";
      complete();
      throw error;
    }
  };
  globalThis.fetch = observedFetch;
  return {
    records,
    async drain(): Promise<void> {
      while (pending.size) await Promise.all([...pending]);
    },
    restore(): void {
      if (globalThis.fetch === observedFetch) globalThis.fetch = originalFetch;
    },
  };
}
