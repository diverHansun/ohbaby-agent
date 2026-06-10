import type { RenderedPart } from "../message/message-row.js";

export interface LiveTailWindow {
  readonly hiddenLineCount: number;
  readonly parts: readonly RenderedPart[];
}

/**
 * Clamps the rendered live message to its trailing `maxLines` terminal rows.
 * Ink rewrites the whole dynamic frame with a terminal clear (including the
 * scrollback buffer) once that frame is as tall as the terminal, so the live
 * region must stay strictly below the terminal height. One row of the budget
 * is reserved for the "hidden lines" marker whenever clipping happens.
 */
export function clampRenderedPartsToTail(
  parts: readonly RenderedPart[],
  maxLines: number,
): LiveTailWindow {
  const totalLines = parts.reduce((total, part) => total + partLines(part), 0);
  if (totalLines <= Math.max(0, maxLines)) {
    return { hiddenLineCount: 0, parts };
  }

  const budget = Math.max(0, maxLines - 1);
  const included: RenderedPart[] = [];
  let remaining = budget;

  for (let index = parts.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const part = parts[index];
    const lines = partLines(part);

    if (lines <= remaining) {
      included.unshift(part);
      remaining -= lines;
      continue;
    }

    const sliced = sliceTextPartTail(part, remaining);
    if (sliced !== null) {
      included.unshift(sliced);
      remaining = 0;
    }
    break;
  }

  const includedLines = included.reduce(
    (total, part) => total + partLines(part),
    0,
  );

  return {
    hiddenLineCount: totalLines - includedLines,
    parts: included,
  };
}

function partLines(part: RenderedPart): number {
  return part.kind === "spinner" ? 1 : part.text.split("\n").length;
}

function sliceTextPartTail(
  part: RenderedPart,
  lineCount: number,
): RenderedPart | null {
  if (part.kind === "spinner") {
    return null;
  }

  const text = part.text.split("\n").slice(-lineCount).join("\n");
  if (part.segments !== undefined) {
    const { segments: _segments, ...plainPart } = part;
    return {
      ...plainPart,
      text,
    };
  }

  return {
    ...part,
    text,
  };
}
