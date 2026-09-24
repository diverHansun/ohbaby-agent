import { renderUnifiedDiff } from "./output.js";

export const EDIT_MAX_BYTES = 10 * 1024 * 1024;
export const WRITE_MAX_BYTES = 20 * 1024 * 1024;
export const DIFF_INPUT_MAX_BYTES = 256 * 1024;
export const DIFF_OUTPUT_MAX_BYTES = 32 * 1024;
export const FUZZY_MAX_BYTES = 256 * 1024;
export const FUZZY_MAX_WORK = 8 * 1024 * 1024;

export function assertMutationBudget(
  label: string,
  bytes: number,
  limit: number,
): void {
  if (bytes > limit)
    throw new Error(
      `${label} budget exceeded: ${String(bytes)} bytes; limit is ${String(limit)} bytes.`,
    );
}

// JSON strings can contain lone UTF-16 surrogates, which Node would silently
// encode as replacement characters. Reject them so UTF-8 byte deltas remain
// additive and exact matching cannot split a supplementary character.
export function assertWellFormedUnicode(text: string, label: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    } else if (code < 0xdc00 || code > 0xdfff) continue;
    throw new Error(
      `${label} must be well-formed Unicode for UTF-8 encoding; lone surrogates are not supported.`,
    );
  }
}

export interface DiffPreview {
  readonly diff: string;
  readonly diffOmitted: boolean;
  readonly diffOmissionReason?: string;
}

export function omittedDiff(reason: string): DiffPreview {
  return { diff: "", diffOmitted: true, diffOmissionReason: reason };
}

export function diffPreviewMessage(preview: DiffPreview): string {
  return preview.diffOmitted
    ? `Diff omitted: ${preview.diffOmissionReason ?? "preview unavailable"}.`
    : preview.diff;
}

export function boundedDiff(before: string, after: string): DiffPreview {
  const bytes = Buffer.byteLength(before) + Buffer.byteLength(after);
  if (bytes > DIFF_INPUT_MAX_BYTES)
    return omittedDiff(
      `combined input exceeds ${String(DIFF_INPUT_MAX_BYTES)} bytes`,
    );
  // The renderer emits every line. Bound its output BEFORE allocating its line
  // arrays or diff. Each input byte can cause at most two output bytes (empty lines).
  // This conservative bound deliberately prefers omission to partial previews.
  if (bytes * 2 + 128 > DIFF_OUTPUT_MAX_BYTES)
    return omittedDiff(
      `preview exceeds ${String(DIFF_OUTPUT_MAX_BYTES)}-byte output budget`,
    );
  return { diff: renderUnifiedDiff({ before, after }), diffOmitted: false };
}
