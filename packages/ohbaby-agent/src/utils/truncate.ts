const DEFAULT_TOKEN_LIMIT = 20_000;
const CHARS_PER_TOKEN = 4;
const TRUNCATION_GUIDANCE = "... [results truncated]";

function characterLimit(tokenLimit = DEFAULT_TOKEN_LIMIT): number {
  return tokenLimit * CHARS_PER_TOKEN;
}

export function truncateIfTooLong(result: string, tokenLimit?: number): string;
export function truncateIfTooLong(
  result: readonly string[],
  tokenLimit?: number,
): string[];
export function truncateIfTooLong(
  result: string | readonly string[],
  tokenLimit?: number,
): string | string[] {
  const limit = characterLimit(tokenLimit);
  if (typeof result === "string") {
    if (result.length <= limit) {
      return result;
    }
    return `${result.slice(0, limit)}\n\n${TRUNCATION_GUIDANCE}`;
  }

  const output: string[] = [];
  let used = 0;
  for (const item of result) {
    if (used + item.length > limit) {
      output.push(TRUNCATION_GUIDANCE);
      return output;
    }
    output.push(item);
    used += item.length;
  }

  return output;
}
