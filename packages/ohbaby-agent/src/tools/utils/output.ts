import { createTwoFilesPatch } from "diff";
import { truncateIfTooLong } from "../../utils/index.js";
import type {
  ToolExecutionContext,
  ToolExecutionResult,
} from "../../core/tool-scheduler/types.js";
import { writeToolOutput } from "../../services/session-storage.js";
import { outputFileNotice } from "../../utils/capped-output-file.js";

export const DEFAULT_OUTPUT_TOKEN_LIMIT = 8_000;

/** Persist only acquired content that the caller's existing display limit omitted. */
export async function persistDisplayedOutput(input: {
  readonly context: ToolExecutionContext;
  readonly acquired: string;
  readonly displayed: string;
  readonly displayLimited: boolean;
  readonly metadata: Record<string, unknown>;
}): Promise<ToolExecutionResult> {
  if (!input.displayLimited)
    return { output: input.displayed, metadata: input.metadata };
  const outputFile = await writeToolOutput({
    environment: input.context.environment,
    callId: input.context.callId,
    text: input.acquired,
  });
  return {
    output: `${input.displayed}\n\n${outputFileNotice(outputFile)}`,
    metadata: { ...input.metadata, outputFile },
  };
}

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

export function renderUnifiedDiff(input: {
  readonly after: string;
  readonly afterLabel?: string;
  readonly before: string;
  readonly beforeLabel?: string;
}): string {
  // jsdiff keeps line endings and missing-final-newline markers intact.
  const patch = createTwoFilesPatch(
    input.beforeLabel ?? "before",
    input.afterLabel ?? "after",
    input.before,
    input.after,
    undefined,
    undefined,
    { context: 3, timeout: 1000 },
  );
  if (patch === undefined)
    throw new Error("Diff calculation exceeded its time budget");
  return patch.replace(/^={3,}\n/u, "").replace(/\n$/u, "");
}
