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

function countOccurrences(content: string, target: string): number {
  return content.split(target).length - 1;
}

function exactRanges(content: string, target: string): MatchRange[] {
  const ranges: MatchRange[] = [];
  let offset = 0;
  while (offset < content.length) {
    const start = content.indexOf(target, offset);
    if (start === -1) {
      break;
    }
    ranges.push({ start, end: start + target.length });
    offset = start + target.length;
  }
  return ranges;
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
  const minIndent = Math.min(
    ...nonEmpty.map((line) => /^\s*/u.exec(line)?.[0].length ?? 0),
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
  if (input.replaceAll) {
    const occurrences = countOccurrences(input.content, input.oldString);
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

  const exact = exactRanges(input.content, input.oldString);
  if (exact.length === 1) {
    const [match] = exact;
    return {
      ...match,
      replacementCount: 1,
      text: input.content.slice(match.start, match.end),
    };
  }
  if (exact.length > 1) {
    multipleMatches(exact.length);
  }

  for (const fuzzy of [
    uniqueRanges(lineTrimmedRanges(input.content, input.oldString)),
    uniqueRanges(indentationFlexibleRanges(input.content, input.oldString)),
    uniqueRanges(whitespaceNormalizedRanges(input.content, input.oldString)),
  ]) {
    if (fuzzy.length === 0) {
      continue;
    }
    if (fuzzy.length > 1) {
      multipleMatches(fuzzy.length);
    }
    const [match] = fuzzy;
    return {
      ...match,
      replacementCount: 1,
      text: input.content.slice(match.start, match.end),
    };
  }
  throw new Error("No occurrences found for edit target.");
}
