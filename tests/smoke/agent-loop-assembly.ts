/** Test-only structural fingerprints; never export prompt text or native payloads. */
import { createHash } from "node:crypto";
import type {
  ContextManager,
  ContextManagerOptions,
  PreparedModelRequest,
  PreparedTurn,
} from "../../packages/ohbaby-agent/src/core/context/index.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function fingerprint(value: unknown): string {
  const normalized = canonical(value);
  return createHash("sha256")
    .update(normalized === undefined ? "undefined" : JSON.stringify(normalized))
    .digest("hex");
}
export function opaqueFingerprints(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(opaqueFingerprints);
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return Object.entries(record).flatMap(([key, item]) =>
    (key === "reasoningDetails" || key === "reasoning_details") &&
    Array.isArray(item)
      ? [fingerprint(item)]
      : typeof item === "string" &&
          (key === "reasoningText" ||
            key === "reasoning_content" ||
            key === "reasoning" ||
            key === "encrypted_content" ||
            key === "signature" ||
            (key === "data" && record.type === "redacted_thinking"))
        ? [fingerprint(item)]
        : opaqueFingerprints(item),
  );
}
export function argumentsFingerprint(value: unknown): string {
  if (typeof value === "string") {
    try {
      return fingerprint(JSON.parse(value));
    } catch {
      return fingerprint(value);
    }
  }
  return fingerprint(value);
}
export function requestShape(request: PreparedModelRequest): {
  digest: string;
  messages: {
    role: string;
    characters: number;
    contentHash: string;
    calls: string[];
    result?: string;
    nativeProtocol?: string;
  }[];
  tools: string[];
  calls: { callId: string; name: string; argumentsHash: string }[];
  results: { callId: string; contentHash: string }[];
  opaque: string[];
} {
  return {
    digest: fingerprint(request),
    messages: request.messages.map((message) => ({
      role: message.role,
      characters:
        typeof message.content === "string" ? message.content.length : 0,
      contentHash: fingerprint(message.content),
      calls:
        message.role === "assistant"
          ? (message.toolCalls?.map((call) => call.callId) ?? [])
          : [],
      ...(message.role === "tool" ? { result: message.callId } : {}),
      ...(message.role === "assistant" && message.modelState
        ? { nativeProtocol: message.modelState.output.protocol }
        : {}),
    })),
    tools: request.tools?.map((tool) => tool.name) ?? [],
    calls: request.messages.flatMap((message) =>
      message.role === "assistant"
        ? (message.toolCalls ?? []).map((call) => ({
            callId: call.callId,
            name: call.name,
            argumentsHash: argumentsFingerprint(call.argumentsJson),
          }))
        : [],
    ),
    results: request.messages.flatMap((message) =>
      message.role === "tool"
        ? [
            {
              callId: message.callId,
              contentHash: fingerprint(message.content),
            },
          ]
        : [],
    ),
    opaque: request.messages.flatMap((message) =>
      message.role === "assistant"
        ? opaqueFingerprints(message.modelState)
        : [],
    ),
  };
}
export interface AssemblyRecord {
  sequence: number;
  sessionId: string;
  scope?: string;
  shape: ReturnType<typeof requestShape>;
  measuredSamePayload: boolean;
  frozen: boolean;
  sentHeuristic: number;
  usage: PreparedTurn["usage"];
}
/** Wrap existing observations and prepareTurn; execute all original production work. */
export function observeAssembly(
  create: (options: ContextManagerOptions) => ContextManager,
  options: ContextManagerOptions,
  records: AssemblyRecord[],
): ContextManager {
  const measured: string[] = [];
  const manager = create({
    ...options,
    onRequestMeasured(request) {
      measured.push(requestShape(request).digest);
      options.onRequestMeasured?.(request);
    },
  });
  const prepare = manager.prepareTurn.bind(manager);
  manager.prepareTurn = async (input): Promise<PreparedTurn> => {
    const start = measured.length;
    const turn = await prepare(input);
    const shape = requestShape(turn.request);
    records.push({
      sequence: records.length + 1,
      sessionId: input.sessionId,
      scope: input.contextScopeId,
      shape,
      measuredSamePayload:
        measured.length > start && measured.at(-1) === shape.digest,
      frozen:
        Object.isFrozen(turn.request) && Object.isFrozen(turn.request.messages),
      sentHeuristic: turn.sentHeuristic,
      usage: turn.usage,
    });
    return turn;
  };
  return manager;
}
export function matchAssembly(
  records: readonly AssemblyRecord[],
  input: PreparedModelRequest & { sessionId?: string; contextScopeId?: string },
): {
  preparedSequence?: number;
  matchesPrepared: boolean;
  shape: ReturnType<typeof requestShape>;
} {
  const shape = requestShape({ messages: input.messages, tools: input.tools });
  const last = records.findLast(
    (row) =>
      row.sessionId === input.sessionId && row.scope === input.contextScopeId,
  );
  return {
    preparedSequence: last?.sequence,
    matchesPrepared: last?.shape.digest === shape.digest,
    shape,
  };
}
