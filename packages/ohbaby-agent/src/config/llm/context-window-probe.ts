import { validateReasoningCapabilities } from "./validation.js";
import type { InterfaceProviderKind, ReasoningCapabilities } from "./types.js";

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
    | "network-error";
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
  const headers =
    input.interfaceProvider === "anthropic"
      ? { "anthropic-version": ANTHROPIC_VERSION, "x-api-key": input.apiKey }
      : { Authorization: `Bearer ${input.apiKey}` };
  try {
    let url = buildModelMetadataUrl(input);
    const visited = new Set<string>();
    let fuzzyContext: number | undefined;
    while (!visited.has(url)) {
      visited.add(url);
      const response = await abortable(
        fetch(url, { headers, method: "GET", signal: controller.signal }),
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
        payload = await abortable(response.json(), controller.signal);
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
      // Existing fuzzy context-window matching remains independent of exact reasoning identity.
      fuzzyContext ??= extractContextWindowTokens(
        findBestModelEntry(entries, input.model),
      );
      if (isRecord(exact)) {
        const contextWindowTokens =
          extractContextWindowTokens(exact) ?? fuzzyContext;
        const candidate =
          exact.reasoningCapabilities ?? exact.reasoning_capabilities;
        let reasoningCapabilities: ReasoningCapabilities | undefined;
        if (candidate !== undefined) {
          try {
            validateReasoningCapabilities(candidate);
            reasoningCapabilities = candidate;
          } catch {
            /* incomplete metadata */
          }
        } else if (exact.reasoning === false) {
          reasoningCapabilities = {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          };
        }
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
    return fuzzyContext === undefined
      ? failed("model-not-found")
      : {
          reasoningReason: "model-not-found",
          contextWindowTokens: fuzzyContext,
        };
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

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
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
    return await Promise.race([work, cancelled]);
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

function findBestModelEntry(
  entries: readonly unknown[],
  model: string,
): Record<string, unknown> | undefined {
  const strongMatch = entries.find(
    (entry) => modelEntryMatchStrength(entry, model) === "strong",
  );
  if (isRecord(strongMatch)) {
    return strongMatch;
  }
  const fuzzyMatch = entries.find(
    (entry) => modelEntryMatchStrength(entry, model) === "fuzzy",
  );
  return isRecord(fuzzyMatch) ? fuzzyMatch : undefined;
}

function modelEntryMatchStrength(
  entry: unknown,
  model: string,
): "strong" | "fuzzy" | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const id =
    stringField(entry, "id") ??
    stringField(entry, "model") ??
    stringField(entry, "name");
  if (id === undefined) {
    return undefined;
  }
  return modelIdMatchStrength(id, model);
}

function modelIdMatchStrength(
  candidate: string,
  target: string,
): "strong" | "fuzzy" | undefined {
  const candidateLower = candidate.toLowerCase();
  const targetLower = target.toLowerCase();
  if (
    candidateLower === targetLower ||
    candidateLower.endsWith(`/${targetLower}`) ||
    targetLower.endsWith(`/${candidateLower}`)
  ) {
    return "strong";
  }

  const candidateTokens = modelIdTokens(candidateLower);
  const targetTokens = modelIdTokens(targetLower);
  const meaningfulTargetTokens = targetTokens.filter(
    (token) => /[a-z]/u.test(token) && token.length >= 3,
  );
  return targetTokens.length > 1 &&
    meaningfulTargetTokens.length > 0 &&
    targetTokens.every((token) => candidateTokenMatches(candidateTokens, token))
    ? "fuzzy"
    : undefined;
}

function modelIdTokens(value: string): readonly string[] {
  return value.match(/[a-z0-9]+/gu) ?? [];
}

function candidateTokenMatches(
  candidateTokens: readonly string[],
  targetToken: string,
): boolean {
  if (/^\d+$/u.test(targetToken)) {
    return candidateTokens.some(
      (candidateToken) =>
        candidateToken === targetToken ||
        (/^[a-z]+\d+$/u.test(candidateToken) &&
          candidateToken.endsWith(targetToken)),
    );
  }
  return candidateTokens.some(
    (candidateToken) =>
      candidateToken === targetToken || candidateToken.includes(targetToken),
  );
}

function stringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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
