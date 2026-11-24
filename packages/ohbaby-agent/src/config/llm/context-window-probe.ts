import type { ReasoningProbeReason } from "./reasoning-active-probe.js";
import { isReasoningEffort, validateReasoningCapabilities } from "ohbaby-llm";
import type { InterfaceProviderKind, ReasoningCapabilities } from "ohbaby-llm";

const ANTHROPIC_VERSION = "2023-06-01";
const CONTEXT_WINDOW_FIELDS = [
  "context_length",
  "contextWindow",
  "context_window",
  "context_window_tokens",
  "contextWindowTokens",
  "max_input_tokens",
  "max_context_tokens",
] as const;
const PROBE_TIMEOUT_MS = 15_000;

export type ContextWindowSource = "detected" | "user" | "default";

export interface ProbeContextWindowInput {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly model: string;
  /** Already confirmed for this exact route. A list of strengths provides no new Off evidence. */
  readonly previousReasoning?: ReasoningCapabilities;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ProbeContextWindowResult {
  readonly contextWindowTokens?: number;
  readonly warning?: string;
  readonly reasoningCapabilities?: ReasoningCapabilities;
  readonly reasoningReason?:
    | "missing-fields"
    | "model-not-found"
    | "authentication"
    | "rate-limit"
    | "http-error"
    | "timeout"
    | "cancelled"
    | "invalid-json"
    | "network-error"
    | ReasoningProbeReason;
}

export async function probeContextWindow(
  input: ProbeContextWindowInput,
): Promise<ProbeContextWindowResult> {
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort(input.signal?.reason);
  };
  input.signal?.addEventListener("abort", cancel, { once: true });
  if (input.signal?.aborted) cancel();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs ?? PROBE_TIMEOUT_MS);
  const failed = (
    reasoningReason: ProbeContextWindowResult["reasoningReason"],
  ): ProbeContextWindowResult => ({
    warning: detectionWarning(),
    reasoningReason,
  });
  const headers: Record<string, string> =
    input.interfaceProvider === "anthropic"
      ? { "anthropic-version": ANTHROPIC_VERSION, "x-api-key": input.apiKey }
      : { Authorization: `Bearer ${input.apiKey}` };
  try {
    let url = buildModelMetadataUrl(input);
    const visited = new Set<string>();
    while (!visited.has(url)) {
      visited.add(url);
      const response = await abortable(
        () => fetch(url, { headers, method: "GET", signal: controller.signal }),
        controller.signal,
      );
      if (!response.ok)
        return failed(
          response.status === 401 || response.status === 403
            ? "authentication"
            : response.status === 429
              ? "rate-limit"
              : "http-error",
        );
      let payload: unknown;
      try {
        payload = await abortable(() => response.json(), controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        return failed("invalid-json");
      }
      const entries = modelEntriesFromPayload(payload);
      const exact = entries.find(
        (entry) =>
          isRecord(entry) &&
          (entry.id ?? entry.model ?? entry.name) === input.model,
      );
      if (isRecord(exact)) {
        const contextWindowTokens = extractContextWindowTokens(exact);
        const reasoningCapabilities = catalogReasoning(exact, input);
        return {
          ...(contextWindowTokens === undefined
            ? { warning: detectionWarning() }
            : { contextWindowTokens }),
          ...(reasoningCapabilities
            ? { reasoningCapabilities }
            : { reasoningReason: "missing-fields" }),
        };
      }
      if (!isRecord(payload) || payload.has_more !== true) break;
      const cursor =
        payload.last_id ??
        (isRecord(entries.at(-1))
          ? (entries.at(-1) as Record<string, unknown>).id
          : undefined);
      if (typeof cursor !== "string") break;
      const next = new URL(url);
      next.searchParams.set(
        input.interfaceProvider === "anthropic" ? "after_id" : "after",
        cursor,
      );
      url = next.toString();
    }
    return failed("model-not-found");
  } catch {
    return failed(
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Mutated by the timeout callback while awaiting network/body reads.
      timedOut
        ? "timeout"
        : input.signal?.aborted
          ? "cancelled"
          : "network-error",
    );
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", cancel);
  }
}

function catalogReasoning(
  entry: Record<string, unknown>,
  input: ProbeContextWindowInput,
): ReasoningCapabilities | undefined {
  for (const candidate of [
    entry.reasoningCapabilities,
    entry.reasoning_capabilities,
  ]) {
    if (candidate === undefined) continue;
    try {
      validateReasoningCapabilities(candidate);
      return candidate;
    } catch {
      // A partial declaration can still have a usable short-form list.
    }
  }
  if (entry.reasoning === false)
    return { mode: "none", wire: "none", supportsDisabled: true };

  const flat = catalogEfforts(entry.reasoning_levels, false);
  const efforts = flat.length
    ? flat
    : catalogEfforts(entry.supported_reasoning_levels, true);
  if (!efforts.length) return undefined;
  const wire =
    input.interfaceProvider === "anthropic" ? "anthropic-adaptive" : "openai";
  const previous = input.previousReasoning;
  return {
    mode: "effort",
    wire,
    efforts,
    effortOrder: efforts,
    supportsDisabled: previous?.wire === wire && previous.supportsDisabled,
  };
}

function catalogEfforts(raw: unknown, objects: boolean): string[] {
  if (!Array.isArray(raw)) return [];
  const efforts = new Set<string>();
  for (let value of raw as unknown[]) {
    if (objects) {
      if (!isRecord(value)) continue;
      value = value.effort;
    }
    const label = typeof value === "string" ? value.trim() : undefined;
    if (isReasoningEffort(label)) efforts.add(label);
  }
  return [...efforts];
}

async function abortable<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = (): void => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Metadata request aborted"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work(), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function buildModelMetadataUrl(input: {
  readonly baseUrl: string;
  readonly interfaceProvider: InterfaceProviderKind;
}): string {
  const url = new URL(input.baseUrl);
  const path = normalizePath(url.pathname);
  url.search = "";
  url.hash = "";

  if (input.interfaceProvider === "anthropic") {
    url.pathname = anthropicModelsPath(path);
    return url.toString();
  }

  url.pathname = openAiModelsPath(path);
  return url.toString();
}

export function extractContextWindowTokens(
  metadata: unknown,
): number | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  for (const field of CONTEXT_WINDOW_FIELDS) {
    const value = metadata[field];
    const parsed = parsePositiveInteger(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function anthropicModelsPath(path: string): string {
  if (path.endsWith("/v1/models")) {
    return path;
  }
  if (path.endsWith("/v1/messages")) {
    return `${path.slice(0, -"/messages".length)}/models`;
  }
  if (path.endsWith("/v1")) {
    return `${path}/models`;
  }
  return `${path}/v1/models`;
}

function openAiModelsPath(path: string): string {
  if (path.endsWith("/models")) {
    return path;
  }
  if (path.endsWith("/chat/completions")) {
    return `${path.slice(0, -"/chat/completions".length)}/models`;
  }
  if (path.endsWith("/responses")) {
    return `${path.slice(0, -"/responses".length)}/models`;
  }
  return `${path}/models`;
}

function normalizePath(pathname: string): string {
  const path = pathname.replace(/\/+$/u, "");
  return path === "" ? "" : path;
}

function modelEntriesFromPayload(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!isRecord(payload)) {
    return [];
  }
  if (Array.isArray(payload.data)) {
    return payload.data;
  }
  if (Array.isArray(payload.models)) {
    return payload.models;
  }
  return [];
}

function parsePositiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function detectionWarning(): string {
  return "Unable to detect model context window from metadata; using the configured fallback.";
}
