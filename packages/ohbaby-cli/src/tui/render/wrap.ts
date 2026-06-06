const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_RESET = `${ANSI_ESCAPE}[0m`;
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${ANSI_ESCAPE}\\[[0-?]*[ -/]*[@-~]`,
  "gu",
);

export function visibleWidth(input: string): number {
  let width = 0;
  for (const token of tokenizeAnsi(input)) {
    if (token.kind === "ansi") {
      continue;
    }
    width += charWidth(token.value);
  }
  return width;
}

export function wrapAnsi(input: string, width: number): string[] {
  const targetWidth = normalizeWidth(width);
  if (!ANSI_ESCAPE_PATTERN.test(input)) {
    ANSI_ESCAPE_PATTERN.lastIndex = 0;
    return wrapPlainText(input, targetWidth);
  }
  ANSI_ESCAPE_PATTERN.lastIndex = 0;
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const token of tokenizeAnsi(input)) {
    if (token.kind === "ansi") {
      current += token.value;
      continue;
    }

    if (token.value === "\n") {
      lines.push(current);
      current = "";
      currentWidth = 0;
      continue;
    }

    const nextWidth = charWidth(token.value);
    if (currentWidth > 0 && currentWidth + nextWidth > targetWidth) {
      lines.push(current.trimEnd());
      current = "";
      currentWidth = 0;
    }

    current += token.value;
    currentWidth += nextWidth;
  }

  lines.push(current.trimEnd());
  return lines;
}

function wrapPlainText(input: string, width: number): string[] {
  return input.split("\n").flatMap((line) => {
    if (line === "") {
      return [""];
    }

    const words = line.split(/(\s+)/u).filter((part) => part.length > 0);
    const output: string[] = [];
    let current = "";

    for (const word of words) {
      if (/^\s+$/u.test(word)) {
        if (current !== "") {
          current += " ";
        }
        continue;
      }

      if (visibleWidth(word) > width) {
        if (current.trimEnd() !== "") {
          output.push(current.trimEnd());
          current = "";
        }
        output.push(...wrapLongPlainWord(word, width));
        continue;
      }

      const next = current === "" ? word : `${current}${word}`;
      if (visibleWidth(next) <= width) {
        current = next;
        continue;
      }

      output.push(current.trimEnd());
      current = word;
    }

    if (current !== "") {
      output.push(current.trimEnd());
    }
    return output.length > 0 ? output : [""];
  });
}

function wrapLongPlainWord(word: string, width: number): string[] {
  const output: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const char of word) {
    const nextWidth = charWidth(char);
    if (currentWidth > 0 && currentWidth + nextWidth > width) {
      output.push(current);
      current = "";
      currentWidth = 0;
    }
    current += char;
    currentWidth += nextWidth;
  }
  if (current !== "") {
    output.push(current);
  }
  return output;
}

export function truncateAnsi(input: string, width: number): string {
  const targetWidth = normalizeWidth(width);
  if (visibleWidth(input) <= targetWidth) {
    return input;
  }

  if (targetWidth <= 3) {
    return ".".repeat(targetWidth);
  }

  const contentWidth = targetWidth - 3;
  let currentWidth = 0;
  let output = "";
  const trailingAnsi: string[] = [];

  for (const token of tokenizeAnsi(input)) {
    if (token.kind === "ansi") {
      output += token.value;
      if (isAnsiReset(token.value)) {
        trailingAnsi.length = 0;
      } else {
        trailingAnsi.push(ANSI_RESET);
      }
      continue;
    }

    const nextWidth = charWidth(token.value);
    if (currentWidth + nextWidth > contentWidth) {
      break;
    }
    output += token.value;
    currentWidth += nextWidth;
  }

  const trailingReset = trailingAnsi.length > 0 ? ANSI_RESET : "";
  return `${output}...${trailingReset}`;
}

interface AnsiToken {
  readonly kind: "ansi" | "text";
  readonly value: string;
}

function tokenizeAnsi(input: string): readonly AnsiToken[] {
  const tokens: AnsiToken[] = [];
  let lastIndex = 0;

  for (const match of input.matchAll(ANSI_ESCAPE_PATTERN)) {
    const index = match.index;
    pushTextTokens(tokens, input.slice(lastIndex, index));
    tokens.push({ kind: "ansi", value: match[0] });
    lastIndex = index + match[0].length;
  }

  pushTextTokens(tokens, input.slice(lastIndex));
  return tokens;
}

function pushTextTokens(tokens: AnsiToken[], text: string): void {
  for (const char of text) {
    tokens.push({ kind: "text", value: char });
  }
}

function normalizeWidth(width: number): number {
  return Math.max(1, Math.floor(width));
}

function charWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }
  if (char === "\n" || char === "\r") {
    return 0;
  }
  if (codePoint === 0) {
    return 0;
  }
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff))
  ) {
    return 2;
  }
  return 1;
}

function isAnsiReset(value: string): boolean {
  return value === "\u001B[0m" || value === "\u001B[m";
}
