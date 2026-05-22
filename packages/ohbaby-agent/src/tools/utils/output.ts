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
    renderUnifiedDiff({
      after: input.newString,
      before: input.oldString,
    }),
  ].join("\n");
}

function splitDiffLines(content: string): string[] {
  const lines = content
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

export function renderUnifiedDiff(input: {
  readonly after: string;
  readonly afterLabel?: string;
  readonly before: string;
  readonly beforeLabel?: string;
}): string {
  const beforeLines = splitDiffLines(input.before);
  const afterLines = splitDiffLines(input.after);
  const beforeStart = beforeLines.length === 0 ? 0 : 1;
  const afterStart = afterLines.length === 0 ? 0 : 1;

  return [
    `--- ${input.beforeLabel ?? "before"}`,
    `+++ ${input.afterLabel ?? "after"}`,
    `@@ -${String(beforeStart)},${String(beforeLines.length)} +${String(afterStart)},${String(afterLines.length)} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join("\n");
}
