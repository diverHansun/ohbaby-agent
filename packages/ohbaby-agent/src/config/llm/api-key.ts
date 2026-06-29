export const OPTIONAL_API_KEY_PLACEHOLDER = "not-needed";

export function nonEmptyApiKey(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value;
}

export function defaultApiKeyEnvForProvider(provider: string): string {
  const normalized = provider
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  const prefix = normalized === "" ? "LLM" : normalized;
  return `${/^[A-Z_]/u.test(prefix) ? prefix : `_${prefix}`}_API_KEY`;
}
