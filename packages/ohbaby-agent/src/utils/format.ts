export interface FormatOptions {
  readonly maxLineLength?: number;
  readonly startLine?: number;
}

const DEFAULT_MAX_LINE_LENGTH = 10_000;

export function formatWithLineNumbers(
  content: string | readonly string[],
  options: FormatOptions = {},
): string {
  const lines: string[] =
    typeof content === "string" ? content.split(/\r?\n/u) : Array.from(content);
  const startLine = options.startLine ?? 1;
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  const formatted: string[] = [];

  for (const [index, line] of lines.entries()) {
    const lineNumber = startLine + index;
    if (line.length <= maxLineLength) {
      formatted.push(`${String(lineNumber)}: ${line}`);
      continue;
    }

    for (let offset = 0, part = 1; offset < line.length; part += 1) {
      const chunk = line.slice(offset, offset + maxLineLength);
      formatted.push(`${String(lineNumber)}.${String(part)}: ${chunk}`);
      offset += maxLineLength;
    }
  }

  return formatted.join("\n");
}

export function checkEmptyContent(content: string): string | null {
  return content.trim() === "" ? "File is empty." : null;
}
