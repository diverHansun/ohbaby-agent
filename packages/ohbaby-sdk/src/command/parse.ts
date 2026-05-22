import type { UiParsedSlashInput, UiSlashTokenSpan } from "./types.js";

function splitFirstLine(input: string): {
  readonly firstLine: string;
  readonly body: string;
} {
  const normalized = input.replace(/\r\n/g, "\n");
  const newlineIndex = normalized.indexOf("\n");
  if (newlineIndex === -1) {
    return { firstLine: normalized, body: "" };
  }

  return {
    firstLine: normalized.slice(0, newlineIndex),
    body: normalized.slice(newlineIndex + 1),
  };
}

function tokenizeCommandLine(commandLine: string): UiSlashTokenSpan[] {
  const tokens: UiSlashTokenSpan[] = [];
  let index = 0;

  while (index < commandLine.length) {
    while (commandLine[index] === " " || commandLine[index] === "\t") {
      index += 1;
    }
    if (index >= commandLine.length) {
      break;
    }

    const tokenStart = index;
    let value = "";
    let quote: string | undefined;

    while (index < commandLine.length) {
      const char = commandLine[index];
      if (quote) {
        if (char === quote) {
          quote = undefined;
          index += 1;
          continue;
        }
        if (char === "\\" && index + 1 < commandLine.length) {
          value += commandLine[index + 1];
          index += 2;
          continue;
        }
        value += char;
        index += 1;
        continue;
      }

      if (char === "'" || char === '"') {
        quote = char;
        index += 1;
        continue;
      }
      if (char === " " || char === "\t") {
        break;
      }
      if (char === "\\" && index + 1 < commandLine.length) {
        value += commandLine[index + 1];
        index += 2;
        continue;
      }

      value += char;
      index += 1;
    }

    tokens.push({ value, start: tokenStart, end: index });
  }

  return tokens;
}

function rawArgsFromToken(
  commandLine: string,
  token?: UiSlashTokenSpan,
): string {
  if (!token) {
    return "";
  }
  return commandLine.slice(token.start).trimStart();
}

export function parseSlashInput(input: string): UiParsedSlashInput | null {
  if (!input.startsWith("/")) {
    return null;
  }

  const { firstLine, body } = splitFirstLine(input);
  const commandLine = firstLine.slice(1).trim();
  const tokenSpans = tokenizeCommandLine(commandLine);
  const segments = tokenSpans.map((token) => token.value);
  const path = segments.slice(0, 1);
  const rawArgs = rawArgsFromToken(commandLine, tokenSpans[1]);

  return {
    raw: input,
    commandLine,
    path,
    segments,
    rawArgs,
    argv: segments.slice(1),
    body,
    tokenSpans,
  };
}
