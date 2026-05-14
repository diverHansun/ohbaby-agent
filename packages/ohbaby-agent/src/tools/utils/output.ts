import { truncateIfTooLong } from "../../utils/index.js";

export const DEFAULT_OUTPUT_TOKEN_LIMIT = 8_000;

export function truncateOutput(
  output: string,
  tokenLimit = DEFAULT_OUTPUT_TOKEN_LIMIT,
): string {
  return truncateIfTooLong(output, tokenLimit);
}

export function renderList(
  values: readonly string[],
  emptyMessage: string,
  tokenLimit?: number,
): string {
  if (values.length === 0) {
    return emptyMessage;
  }

  return truncateOutput(values.join("\n"), tokenLimit);
}

export function renderReplacementDiff(input: {
  readonly newString: string;
  readonly oldString: string;
  readonly replacementCount: number;
}): string {
  return [
    `Replacements: ${String(input.replacementCount)}`,
    "--- before",
    "+++ after",
    `-${input.oldString}`,
    `+${input.newString}`,
  ].join("\n");
}
