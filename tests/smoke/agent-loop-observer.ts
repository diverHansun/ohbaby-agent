/** Test-only observation at the production provider and HTTP boundaries. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { LLMClientInstance } from "../../packages/ohbaby-agent/src/core/llm-client/index.js";
import type {
  LifecycleEvent,
  LifecycleResult,
} from "../../packages/ohbaby-agent/src/core/lifecycle/index.js";

export type LoopMode =
  | "stage-a"
  | "e1"
  | "length"
  | "transport"
  | "cancel"
  | "compaction";
export interface LoopRequest {
  sequence: number;
  purpose?: string;
  exhausted: boolean;
  scope?: string;
  nativeCount: number;
  finishes: string[];
  outputCharacters: number;
  http: LoopWire[];
}
export interface LoopWire {
  status?: number;
  roles: string[];
  calls: string[];
  results: string[];
  nativeTypes: string[];
  textHash: string;
  textCharacters: number;
  maxOutputTokens?: number;
  /** Text stays in memory only; serialize with publicWire. */
  text: string;
  assistantText: string;
}
export interface LoopAudit {
  mode: LoopMode;
  requests: LoopRequest[];
  events: Record<string, unknown>[];
  results: Pick<
    LifecycleResult,
    "success" | "finishReason" | "terminalReason" | "usage"
  >[];
  injected: boolean;
  onCancel?: () => Promise<void>;
}
export const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export function summarizeWire(body: unknown): LoopWire {
  const data = object(body);
  const rows = array(data.input ?? data.messages);
  const calls: string[] = [],
    results: string[] = [],
    roles: string[] = [],
    nativeTypes: string[] = [],
    texts: string[] = [],
    assistantTexts: string[] = [];
  for (const raw of rows) {
    const row = object(raw);
    if (typeof row.role === "string") roles.push(row.role);
    if (row.type === "function_call") calls.push(string(row.call_id));
    if (row.type === "function_call_output") results.push(string(row.call_id));
    if (row.type === "reasoning") nativeTypes.push("reasoning");
    if (row.role === "tool") results.push(string(row.tool_call_id));
    for (const call of array(row.tool_calls))
      calls.push(string(object(call).id));
    if (typeof row.content === "string" && row.role !== "tool") {
      texts.push(row.content);
      if (row.role === "assistant") assistantTexts.push(row.content);
    }
    for (const partRaw of array(row.content)) {
      const part = object(partRaw);
      if (part.type === "tool_use") calls.push(string(part.id));
      if (part.type === "tool_result") results.push(string(part.tool_use_id));
      if (["thinking", "redacted_thinking"].includes(string(part.type)))
        nativeTypes.push(string(part.type));
      if (["text", "input_text", "output_text"].includes(string(part.type))) {
        texts.push(string(part.text));
        if (row.role === "assistant") assistantTexts.push(string(part.text));
      }
    }
  }
  const text = texts.join("\n");
  const max =
    data.max_output_tokens ?? data.max_tokens ?? data.max_completion_tokens;
  return {
    roles,
    calls,
    results,
    nativeTypes,
    text,
    assistantText: assistantTexts.join("\n"),
    textHash: hash(text),
    textCharacters: text.length,
    ...(typeof max === "number" ? { maxOutputTokens: max } : {}),
  };
}
export function publicWire(
  wire: LoopWire,
): Omit<LoopWire, "text" | "assistantText"> {
  const { text: _text, assistantText: _assistantText, ...safe } = wire;
  return safe;
}
export function publicAudit(audit: LoopAudit): unknown {
  return {
    mode: audit.mode,
    injected: audit.injected,
    requests: audit.requests.map((row) => ({
      ...row,
      http: row.http.map(publicWire),
    })),
    events: audit.events,
    results: audit.results,
  };
}

/** Interception uses the SDK fetch seam, forwards all arguments, and never reads headers. */
export function observeClient(
  client: LLMClientInstance,
  audit: LoopAudit,
): void {
  const context = new AsyncLocalStorage<LoopRequest>();
  const sdk = (
    client.provider as unknown as { client: { fetch: typeof fetch } }
  ).client;
  const originalFetch = sdk.fetch.bind(sdk);
  sdk.fetch = async (input, init) => {
    const row = context.getStore();
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const wire = summarizeWire(body);
    row?.http.push(wire);
    const response = await originalFetch(input, init);
    wire.status = response.status;
    return response;
  };
  const original = client.provider.streamResponse.bind(client.provider);
  client.provider.streamResponse = async (request) => {
    const row: LoopRequest = {
      sequence: audit.requests.length + 1,
      purpose: request.purpose,
      scope: request.contextScopeId,
      exhausted: false,
      nativeCount: request.messages.filter(
        (m) => m.role === "assistant" && m.modelState,
      ).length,
      finishes: [],
      outputCharacters: 0,
      http: [],
    };
    audit.requests.push(row);
    // A transport boundary fixture deliberately restricts the real Responses output budget.
    const actual =
      audit.mode === "length" &&
      request.purpose === "agent-step" &&
      !audit.injected
        ? {
            ...request,
            maxTokens: 128,
            reasoning: {
              ...request.reasoning,
              mode: "disabled" as const,
              wire: request.reasoning?.wire ?? "openai",
              capabilitySource: "test-output-limit",
              intent: {
                effort: request.reasoning?.intent.effort ?? "medium",
                explicit: { enabled: true, effort: false },
                enabled: false,
              },
            },
          }
        : request;
    if (actual !== request) audit.injected = true;
    const iterable = await context.run(row, () => original(actual));
    const iterator = iterable[Symbol.asyncIterator]();
    return (async function* () {
      try {
        for (;;) {
          const next = await context.run(row, () => iterator.next());
          if (next.done) {
            row.exhausted = true;
            return;
          }
          const event = next.value;
          if (event.finishReason) row.finishes.push(event.finishReason);
          row.outputCharacters += event.textDelta?.length ?? 0;
          yield event;
          if (
            request.purpose === "agent-step" &&
            event.textDelta?.length &&
            row.outputCharacters >= 64 &&
            !audit.injected
          ) {
            if (audit.mode === "transport") {
              audit.injected = true;
              throw Object.assign(
                new Error(
                  "controlled local transport interruption after real upstream text",
                ),
                { code: "ECONNRESET" },
              );
            }
            if (audit.mode === "cancel") {
              audit.injected = true;
              await audit.onCancel?.();
            }
          }
        }
      } finally {
        if (!row.exhausted) await iterator.return?.();
      }
    })();
  };
}

export function observeEvent(event: LifecycleEvent): Record<string, unknown> {
  return {
    type: event.type,
    step: event.step,
    ...("finishReason" in event ? { finishReason: event.finishReason } : {}),
    ...(event.type === "tool:start" || event.type === "tool:result"
      ? { callId: event.callId, toolName: event.toolName }
      : {}),
    ...(event.type === "tool:result"
      ? { success: event.result.status === "success" }
      : {}),
    ...(event.type === "llm:complete"
      ? {
          calls: event.parsedToolCalls?.map((call) => ({
            callId: call.callId,
            name: call.name,
          })),
          usage: event.tokenUsage,
        }
      : {}),
    ...(event.type === "context:prepared"
      ? { usage: event.usage, contextScopeId: event.contextScopeId }
      : {}),
  };
}

/** Non-vacuous cross-boundary checks: execution IDs must appear in later real HTTP. */
export function toolHandoffChecks(
  audit: Pick<LoopAudit, "requests" | "events">,
): {
  agentStepWireCount: number;
  startedCalls: number;
  allExecuted: boolean;
  allReplayed: boolean;
  allResultsPaired: boolean;
} {
  const wires = audit.requests
    .filter((row) => row.purpose === "agent-step")
    .flatMap((row) => row.http);
  const started = audit.events.filter((event) => event.type === "tool:start");
  const results = audit.events.filter((event) => event.type === "tool:result");
  const ids = started.map((event) =>
    typeof event.callId === "string" ? event.callId : "",
  );
  return {
    agentStepWireCount: wires.length,
    startedCalls: ids.length,
    allExecuted:
      ids.length > 0 &&
      ids.every(
        (id) => id.length > 0 && results.some((event) => event.callId === id),
      ),
    allReplayed:
      ids.length > 0 &&
      ids.every(
        (id) =>
          id.length > 0 &&
          wires.some(
            (wire) => wire.calls.includes(id) && wire.results.includes(id),
          ),
      ),
    allResultsPaired:
      results.length > 0 &&
      results.every(
        (event) =>
          typeof event.callId === "string" && ids.includes(event.callId),
      ),
  };
}
