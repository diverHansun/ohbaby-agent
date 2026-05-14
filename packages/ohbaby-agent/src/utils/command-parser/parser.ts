import type { CommandDetail, ParsedCommand } from "./types.js";

const COMMAND_SEPARATORS = new Set(["&&", "||", "|", ";", "\n"]);
const WRAPPER_COMMANDS = new Set(["command", "env", "sudo"]);
const PATH_PREFIX_PATTERN = /^(?:\.{1,2}[\\/]|~[\\/]|[\\/]|[A-Za-z]:[\\/])/u;
const PATH_SUFFIX_PATTERN = /^[\w.-]+(?:[\\/][\w .-]+)+$/u;

interface TokenizedCommand {
  readonly hasError: boolean;
  readonly tokens: readonly string[];
}

function tokenize(command: string): TokenizedCommand {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((char === "\"" || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (quote === null && /\s/u.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (quote === null && (char === ";" || char === "|" || char === "&")) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      const previous = tokens.at(-1);
      if (
        (char === "|" || char === "&") &&
        previous === char
      ) {
        tokens[tokens.length - 1] = `${previous}${char}`;
      } else {
        tokens.push(char);
      }
      continue;
    }

    current += char;
  }
  if (current) {
    tokens.push(current);
  }

  return { hasError: quote !== null || escaped, tokens };
}

function segmentTokens(tokens: readonly string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (COMMAND_SEPARATORS.has(token)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

function unwrapRoot(tokens: readonly string[]): string | null {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^\w+=/u.test(token)) {
      index += 1;
      continue;
    }
    if (!WRAPPER_COMMANDS.has(token)) {
      return token;
    }
    index += 1;
    while (index < tokens.length && tokens[index].startsWith("-")) {
      index += 1;
    }
    if (token === "env") {
      while (index < tokens.length && /^\w+=/u.test(tokens[index])) {
        index += 1;
      }
    }
  }

  return null;
}

function tokenLooksLikePath(token: string): boolean {
  if (token.startsWith("-")) {
    return false;
  }
  return PATH_PREFIX_PATTERN.test(token) || PATH_SUFFIX_PATTERN.test(token);
}

export function detectPaths(command: string): string[] {
  const parsed = parseCommand(command);
  return parsed.details.flatMap((detail) => [...detail.paths]);
}

export function parseCommand(command: string): ParsedCommand {
  const tokenized = tokenize(command);
  const details: CommandDetail[] = [];
  for (const tokens of segmentTokens(tokenized.tokens)) {
    const root = unwrapRoot(tokens);
    if (!root) {
      continue;
    }
    details.push({
      paths: tokens.filter(tokenLooksLikePath),
      root,
      text: tokens.join(" "),
    });
  }

  return {
    details,
    hasError: tokenized.hasError,
    roots: details.map((detail) => detail.root),
  };
}

export function getCommandRoots(command: string): string[] {
  return [...parseCommand(command).roots];
}

export function matchesPattern(command: string, pattern: string): boolean {
  const escapeRegex = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
  const regex = new RegExp(
    `^${escapeRegex.replaceAll("*", ".*").replace(/\s+/gu, "\\s+")}$`,
    "u",
  );
  return regex.test(command.trim());
}
