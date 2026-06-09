import type { InterfaceProviderKind } from "./types.js";

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
}

export interface ProbeContextWindowResult {
  readonly contextWindowTokens?: number;
  readonly warning?: string;
}

export async function probeContextWindow(
  input: ProbeContextWindowInput,
): Promise<ProbeContextWindowResult> {
  if (typeof fetch !== "function") {
    return { warning: detectionWarning() };
  }

  const url = buildModelMetadataUrl(input);
  const headers =
    input.interfaceProvider === "anthropic"
      ? {
          "anthropic-version": ANTHROPIC_VERSION,
          "x-api-key": input.apiKey,
        }
      : {
          Authorization: `Bearer ${input.apiKey}`,
        };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, PROBE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        method: "GET",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      return { warning: detectionWarning() };
    }

    const payload = await response.json();
    const modelMetadata = findBestModelEntry(
      modelEntriesFromPayload(payload),
      input.model,
    );
    const contextWindowTokens = extractContextWindowTokens(modelMetadata);
    if (contextWindowTokens === undefined) {
      return { warning: detectionWarning() };
    }
    return { contextWindowTokens };
  } catch {
    return { warning: detectionWarning() };
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
  return typeof value === "string" && value.trim() !== ""
    ? value
    : undefined;
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
