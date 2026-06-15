const DEFAULT_TITLE_PROMPT_MAX_LENGTH = 2_000;
const DEFAULT_TEMPORARY_TITLE_MAX_LENGTH = 48;
const REDACTION = "[redacted]";
const LEGACY_NEW_SESSION_TITLE_PATTERN = /^New session\s+-\s+.+$/u;

export interface SanitizePromptOptions {
  readonly maxLength?: number;
}

export function sanitizePromptForSessionTitle(
  prompt: string,
  options: SanitizePromptOptions = {},
): string {
  const maxLength = options.maxLength ?? DEFAULT_TITLE_PROMPT_MAX_LENGTH;
  return truncateText(normalizeWhitespace(redactSecrets(prompt)), maxLength);
}

export function createTemporarySessionTitle(
  firstUserMessage: string,
  maxLength = DEFAULT_TEMPORARY_TITLE_MAX_LENGTH,
): string {
  const title = sanitizePromptForSessionTitle(firstUserMessage, { maxLength });
  return title === "" ? "Untitled session" : title;
}

export function isDefaultSessionTitle(title: string): boolean {
  const normalized = normalizeWhitespace(title);
  return (
    normalized === "" ||
    normalized === "New session" ||
    normalized === "Untitled session" ||
    normalized === "(Empty response)" ||
    LEGACY_NEW_SESSION_TITLE_PATTERN.test(normalized)
  );
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(authorization\s*:\s*bearer\s+)([^\s,;]+)/giu, `$1${REDACTION}`)
    .replace(
      /\b([a-z0-9_]*(?:api[_-]?key|token|secret|password|passwd|pwd)[a-z0-9_]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      `$1${REDACTION}`,
    )
    .replace(/\bsk-[a-z0-9_-]{8,}\b/giu, REDACTION)
    .replace(/\bgh[pousr]_[a-z0-9_]{8,}\b/giu, REDACTION);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  const normalizedMaxLength = Math.max(0, Math.floor(maxLength));
  if (value.length <= normalizedMaxLength) {
    return value;
  }
  if (normalizedMaxLength <= 3) {
    return ".".repeat(normalizedMaxLength);
  }
  return `${value.slice(0, normalizedMaxLength - 3).trimEnd()}...`;
}
