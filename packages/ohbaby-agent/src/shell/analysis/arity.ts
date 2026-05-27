const DEFAULT_ARITY = 1;

const COMMAND_ARITY = new Map<string, number>([
  ["docker", 2],
  ["git", 2],
]);

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/\.exe$/u, "");
}

export function computeShellArityKey(tokens: readonly string[]): string {
  const normalized = tokens.map(normalizeToken).filter(Boolean);
  if (normalized.length === 0) {
    return "*";
  }

  const arity = COMMAND_ARITY.get(normalized[0]) ?? DEFAULT_ARITY;
  const prefix = normalized.slice(0, Math.min(arity, normalized.length));
  return `${prefix.join(" ")} *`;
}
