import { FUZZY_MAX_BYTES, FUZZY_MAX_WORK } from "./mutation-budgets.js";
import { ToolParameterError } from "./params.js";

export interface EditMatch {
  readonly end: number;
  readonly replacementCount: number;
  readonly start: number;
  readonly text: string;
}

interface MatchRange {
  readonly end: number;
  readonly start: number;
}

// KMP scans the whole file in linear work, retaining only a prefix table
// bounded by the already-validated old_string input.
function exactMatches(
  content: string,
  target: string,
): { count: number; first: number } {
  if (!target.length)
    throw new ToolParameterError("Edit target must not be empty.");
  const prefix = new Uint32Array(target.length);
  for (let i = 1, j = 0; i < target.length; i += 1) {
    while (j > 0 && target[i] !== target[j]) j = prefix[j - 1] ?? 0;
    if (target[i] === target[j]) j += 1;
    prefix[i] = j;
  }
  let count = 0;
  let first = -1;
  for (let i = 0, j = 0; i < content.length; i += 1) {
    while (j > 0 && content[i] !== target[j]) j = prefix[j - 1] ?? 0;
    if (content[i] === target[j]) j += 1;
    if (j === target.length) {
      if (first === -1) first = i - j + 1;
      count += 1;
      j = 0;
    }
  }
  return { count, first };
}

function lineStartOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
}

function rangeForLines(
  lines: readonly string[],
  offsets: readonly number[],
  startLine: number,
  lineCount: number,
): MatchRange {
  const start = offsets[startLine] ?? 0;
  const lastLine = startLine + lineCount - 1;
  const end = (offsets[lastLine] ?? start) + (lines[lastLine]?.length ?? 0);
  return { start, end };
}

function searchLines(find: string): string[] {
  const lines = find.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function lineTrimmedRanges(content: string, find: string): MatchRange[] {
  const contentLines = content.split("\n");
  const findLines = searchLines(find);
  if (findLines.length === 0 || findLines.length > contentLines.length) {
    return [];
  }
  const offsets = lineStartOffsets(contentLines);
  const ranges: MatchRange[] = [];
  for (
    let startLine = 0;
    startLine <= contentLines.length - findLines.length;
    startLine += 1
  ) {
    const matches = findLines.every(
      (line, index) => contentLines[startLine + index]?.trim() === line.trim(),
    );
    if (matches) {
      ranges.push(
        rangeForLines(contentLines, offsets, startLine, findLines.length),
      );
    }
  }
  return ranges;
}

function removeSharedIndent(text: string): string {
  const lines = text.split("\n");
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length === 0) {
    return text;
  }
  const minIndent = nonEmpty.reduce(
    (minimum, line) => Math.min(minimum, /^\s*/u.exec(line)?.[0].length ?? 0),
    Infinity,
  );
  return lines
    .map((line) => (line.trim() === "" ? line : line.slice(minIndent)))
    .join("\n");
}

function indentationFlexibleRanges(
  content: string,
  find: string,
): MatchRange[] {
  const contentLines = content.split("\n");
  const findLines = searchLines(find);
  if (findLines.length <= 1 || findLines.length > contentLines.length) {
    return [];
  }
  const normalizedFind = removeSharedIndent(findLines.join("\n"));
  const offsets = lineStartOffsets(contentLines);
  const ranges: MatchRange[] = [];
  for (
    let startLine = 0;
    startLine <= contentLines.length - findLines.length;
    startLine += 1
  ) {
    const block = contentLines
      .slice(startLine, startLine + findLines.length)
      .join("\n");
    if (removeSharedIndent(block) === normalizedFind) {
      ranges.push(
        rangeForLines(contentLines, offsets, startLine, findLines.length),
      );
    }
  }
  return ranges;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function whitespaceNormalizedRanges(
  content: string,
  find: string,
): MatchRange[] {
  const contentLines = content.split("\n");
  const findLines = searchLines(find);
  if (findLines.length === 0 || findLines.length > contentLines.length) {
    return [];
  }
  const normalizedFind = normalizeWhitespace(findLines.join("\n"));
  const offsets = lineStartOffsets(contentLines);
  const ranges: MatchRange[] = [];
  for (
    let startLine = 0;
    startLine <= contentLines.length - findLines.length;
    startLine += 1
  ) {
    const block = contentLines
      .slice(startLine, startLine + findLines.length)
      .join("\n");
    if (normalizeWhitespace(block) === normalizedFind) {
      ranges.push(
        rangeForLines(contentLines, offsets, startLine, findLines.length),
      );
    }
  }
  return ranges;
}

function uniqueRanges(ranges: readonly MatchRange[]): MatchRange[] {
  const seen = new Set<string>();
  const unique: MatchRange[] = [];
  for (const range of ranges) {
    const key = `${String(range.start)}:${String(range.end)}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(range);
    }
  }
  return unique;
}

function multipleMatches(count: number): never {
  throw new ToolParameterError(
    `Multiple occurrences found (${String(count)}); set replace_all to true or include more context.`,
  );
}

export function findEditMatch(input: {
  readonly content: string;
  readonly oldString: string;
  readonly replaceAll: boolean;
}): EditMatch {
  const exact = exactMatches(input.content, input.oldString);
  if (input.replaceAll) {
    const occurrences = exact.count;
    if (occurrences === 0) {
      throw new Error("No occurrences found for edit target.");
    }
    return {
      end: input.oldString.length,
      replacementCount: occurrences,
      start: 0,
      text: input.oldString,
    };
  }

  if (exact.count === 1) {
    return {
      start: exact.first,
      end: exact.first + input.oldString.length,
      replacementCount: 1,
      text: input.oldString,
    };
  }
  if (exact.count > 1) multipleMatches(exact.count);
  const contentBytes = Buffer.byteLength(input.content);
  let findLines = 1;
  for (const char of input.oldString) if (char === "\n") findLines += 1;
  let contentLines = 1;
  for (const char of input.content) if (char === "\n") contentLines += 1;
  if (
    contentLines * Buffer.byteLength(input.oldString) > FUZZY_MAX_WORK ||
    contentBytes > FUZZY_MAX_BYTES ||
    contentBytes * findLines > FUZZY_MAX_WORK
  ) {
    throw new Error(
      "Edit fuzzy matching budget exceeded; provide an exact old_string.",
    );
  }
  for (const fuzzy of [
    lineTrimmedRanges,
    indentationFlexibleRanges,
    whitespaceNormalizedRanges,
  ]) {
    const ranges = uniqueRanges(fuzzy(input.content, input.oldString));
    if (ranges.length === 0) {
      continue;
    }
    if (ranges.length > 1) {
      multipleMatches(ranges.length);
    }
    const [match] = ranges;
    return {
      ...match,
      replacementCount: 1,
      text: input.content.slice(match.start, match.end),
    };
  }
  throw new Error("No occurrences found for edit target.");
}
