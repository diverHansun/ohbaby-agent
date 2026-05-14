import type {
  TuiCommandCatalog,
  TuiCommandInvocation,
  TuiCommandSpec,
} from "../store/snapshot.js";

export interface ParsedSlashInput {
  readonly kind: "slash" | "text";
  readonly raw: string;
  readonly body: string;
  readonly tokens: readonly string[];
  readonly tokenSpans: readonly TokenSpan[];
  readonly path: readonly string[];
  readonly rawPath: string;
  readonly rawArgs: string;
  readonly argv: readonly string[];
}

export type ResolveCommandResult =
  | {
      readonly kind: "resolved";
      readonly command: TuiCommandSpec;
      readonly invocation: TuiCommandInvocation;
    }
  | {
      readonly kind: "not-found";
      readonly reason: string;
    }
  | {
      readonly kind: "not-slash";
      readonly reason: string;
    };

export interface CommandRuntimeOptions {
  readonly surface: "tui";
  readonly sessionId?: string;
}

let invocationCounter = 0;

export function parseSlashInput(input: string): ParsedSlashInput {
  const raw = input;

  if (!input.startsWith("/")) {
    return {
      argv: [],
      body: input,
      kind: "text",
      path: [],
      raw,
      rawArgs: "",
      rawPath: "",
      tokenSpans: [],
      tokens: [],
    };
  }

  const body = input.slice(1).trimStart();
  const tokenSpans = tokenizeCommandLine(body);
  const tokens = tokenSpans.map((span) => span.value);
  const pathLength = inferDisplayPathLength(tokens);
  const path = tokens.slice(0, pathLength);
  const rawPath = path.join(" ");
  const rawArgs = extractRawArgs(body, tokenSpans, pathLength);

  return {
    argv: tokens.slice(pathLength),
    body,
    kind: "slash",
    path,
    raw,
    rawArgs,
    rawPath,
    tokenSpans,
    tokens,
  };
}

export function resolveCommand(
  parsed: ParsedSlashInput,
  catalog: TuiCommandCatalog,
  options: CommandRuntimeOptions,
): ResolveCommandResult {
  if (parsed.kind !== "slash") {
    return {
      kind: "not-slash",
      reason: "Input is not a slash command",
    };
  }

  const resolved = findExactCommand(parsed.tokens, catalog, options);

  if (resolved === undefined) {
    return {
      kind: "not-found",
      reason: "No exact command match",
    };
  }

  const { command, tokenCount } = resolved;
  const argv = parsed.tokens.slice(tokenCount);
  const rawArgs = extractRawArgs(parsed.body, parsed.tokenSpans, tokenCount);

  return {
    command,
    invocation: {
      argv,
      clientInvocationId: createInvocationId(),
      commandId: command.id,
      path: command.path,
      raw: parsed.raw,
      rawArgs,
      sessionId: options.sessionId,
      surface: "tui",
    },
    kind: "resolved",
  };
}

export function filterCommandCatalog(
  parsed: ParsedSlashInput,
  catalog: TuiCommandCatalog,
  options: Pick<CommandRuntimeOptions, "surface">,
): readonly TuiCommandSpec[] {
  if (parsed.kind !== "slash") {
    return [];
  }

  const query = parsed.body.trim().toLowerCase();

  return catalog.commands
    .filter((command) => commandSupportsSurface(command, options.surface))
    .filter((command) => {
      const path = command.path.join(" ").toLowerCase();

      if (query === "") {
        return true;
      }

      return path.startsWith(query) || pathIncludesAlias(command, query);
    });
}

export function applySlashCompletion(
  input: string,
  catalog: TuiCommandCatalog,
  options: Pick<CommandRuntimeOptions, "surface">,
): string {
  const parsed = parseSlashInput(input);
  const matches = filterCommandCatalog(parsed, catalog, options);

  if (matches.length !== 1) {
    return input;
  }

  return `/${matches[0]?.path.join(" ")} `;
}

function findExactCommand(
  tokens: readonly string[],
  catalog: TuiCommandCatalog,
  options: CommandRuntimeOptions,
):
  | {
      readonly command: TuiCommandSpec;
      readonly tokenCount: number;
    }
  | undefined {
  const candidates = catalog.commands
    .filter((command) => commandSupportsSurface(command, options.surface))
    .map((command) => ({
      command,
      tokenCount: matchedTokenCount(command, tokens),
    }))
    .filter((candidate) => candidate.tokenCount > 0)
    .filter((candidate) =>
      tokens.length === candidate.tokenCount
        ? true
        : candidate.command.acceptsArguments,
    )
    .sort((left, right) => right.tokenCount - left.tokenCount);

  return candidates[0];
}

function commandSupportsSurface(
  command: TuiCommandSpec,
  surface: string,
): boolean {
  return command.surfaces === undefined || command.surfaces.includes(surface);
}

function matchedTokenCount(
  command: TuiCommandSpec,
  tokens: readonly string[],
): number {
  if (matchesPath(command.path, tokens)) {
    return command.path.length;
  }

  return matchedAliasLength(command, tokens);
}

function matchesPath(
  path: readonly string[],
  tokens: readonly string[],
): boolean {
  if (tokens.length < path.length) {
    return false;
  }

  return path.every((segment, index) => tokens[index] === segment);
}

function matchedAliasLength(
  command: TuiCommandSpec,
  tokens: readonly string[],
): number {
  for (const alias of command.aliases ?? []) {
    if (tokens.length < alias.length) {
      continue;
    }

    if (alias.every((segment, index) => tokens[index] === segment)) {
      return alias.length;
    }
  }

  return 0;
}

function pathIncludesAlias(command: TuiCommandSpec, query: string): boolean {
  return (
    command.aliases?.some((alias) =>
      alias.join(" ").toLowerCase().startsWith(query),
    ) ?? false
  );
}

function inferDisplayPathLength(tokens: readonly string[]): number {
  if (tokens.length === 0) {
    return 0;
  }

  if (tokens.length === 1 || looksLikeArgument(tokens[1] ?? "")) {
    return 1;
  }

  return 2;
}

function looksLikeArgument(token: string): boolean {
  return token.startsWith("-") || token.includes(".") || token.includes("=");
}

interface TokenSpan {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

function extractRawArgs(
  body: string,
  tokenSpans: readonly TokenSpan[],
  pathLength: number,
): string {
  if (pathLength <= 0 || pathLength > tokenSpans.length) {
    return "";
  }

  const precedingToken = tokenSpans[pathLength - 1];

  return body.slice(precedingToken.end).trimStart();
}

function tokenizeCommandLine(input: string): readonly TokenSpan[] {
  const tokens: TokenSpan[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let tokenStart: number | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";

    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        tokenStart ??= index;
        current += char;
      }

      continue;
    }

    if (char === "\"" || char === "'") {
      tokenStart ??= index;
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current !== "") {
        tokens.push({
          end: index,
          start: tokenStart ?? index - current.length,
          value: current,
        });
        current = "";
        tokenStart = null;
      }

      continue;
    }

    tokenStart ??= index;
    current += char;
  }

  if (current !== "") {
    tokens.push({
      end: input.length,
      start: tokenStart ?? input.length - current.length,
      value: current,
    });
  }

  return tokens;
}

function createInvocationId(): string {
  invocationCounter += 1;
  return `tui_${String(invocationCounter)}`;
}
