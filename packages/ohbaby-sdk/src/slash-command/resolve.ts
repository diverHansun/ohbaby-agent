import type {
  UiParsedSlashCommandInput,
  UiSlashCommandCatalog,
  UiSlashCommandResolveOptions,
  UiSlashCommandResolveResult,
  UiSlashCommandSpec,
  UiSlashCommandSurface,
  UiSlashTokenSpan,
} from "./types.js";

interface MatchCandidate {
  readonly command: UiSlashCommandSpec;
  readonly path: readonly string[];
  readonly usedAlias?: readonly string[];
}

function candidateMatchedLength(candidate: MatchCandidate): number {
  return candidate.usedAlias?.length ?? candidate.path.length;
}

function normalizePath(path: readonly string[]): string {
  return path.join("/").toLowerCase();
}

function normalizePartialPath(input: string): string {
  return input.trim().replace(/\s+/g, "/").toLowerCase();
}

function pathMatches(
  candidatePath: readonly string[],
  segments: readonly string[],
): boolean {
  if (candidatePath.length > segments.length) {
    return false;
  }
  return candidatePath.every(
    (segment, index) =>
      segment.toLowerCase() === segments[index]?.toLowerCase(),
  );
}

function unknownCommand(
  parsed: UiParsedSlashCommandInput,
): UiSlashCommandResolveResult {
  return {
    ok: false,
    error: {
      code: "COMMAND_NOT_FOUND",
      message: `Unknown command "/${parsed.commandLine}"`,
    },
  };
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

function findCandidates(
  catalog: UiSlashCommandCatalog,
  segments: readonly string[],
): MatchCandidate[] {
  const candidates: MatchCandidate[] = [];
  for (const command of catalog.commands) {
    if (pathMatches(command.path, segments)) {
      candidates.push({ command, path: command.path });
    }
    for (const alias of command.aliases ?? []) {
      if (pathMatches(alias, segments)) {
        candidates.push({ command, path: command.path, usedAlias: alias });
      }
    }
  }

  return candidates.sort((left, right) => {
    const rightLength = right.usedAlias?.length ?? right.path.length;
    const leftLength = left.usedAlias?.length ?? left.path.length;
    if (rightLength !== leftLength) {
      return rightLength - leftLength;
    }
    return normalizePath(left.path).localeCompare(normalizePath(right.path));
  });
}

export function resolveSlashCommand(
  catalog: UiSlashCommandCatalog,
  parsed: UiParsedSlashCommandInput | null,
  options: UiSlashCommandResolveOptions = {},
): UiSlashCommandResolveResult {
  if (!parsed) {
    return {
      ok: false,
      error: {
        code: "NOT_A_COMMAND",
        message: "Input is not a slash command",
      },
    };
  }
  if (parsed.segments.length === 0) {
    return unknownCommand(parsed);
  }

  const allCandidates = findCandidates(catalog, parsed.segments);
  const candidates = allCandidates.filter((candidate) =>
    isVisibleOnSurface(candidate.command, options.surface),
  );
  if (allCandidates.length > 0 && candidates.length === 0) {
    return {
      ok: false,
      error: {
        code: "COMMAND_NOT_AVAILABLE_ON_SURFACE",
        message: `Command is not available on surface: ${options.surface ?? "unknown"}`,
      },
    };
  }

  const validCandidates = candidates.filter((candidate) => {
    const matchedLength = candidateMatchedLength(candidate);
    const hasRemainingArgs = parsed.segments.length > matchedLength;
    return !hasRemainingArgs || candidate.command.acceptsArguments === true;
  });
  const bestMatchedLength = validCandidates[0]
    ? candidateMatchedLength(validCandidates[0])
    : undefined;
  const bestCandidates = validCandidates.filter(
    (candidate) => candidateMatchedLength(candidate) === bestMatchedLength,
  );
  if (bestCandidates.length === 0) {
    return unknownCommand(parsed);
  }

  const matchedCommandIds = new Set(
    bestCandidates.map((candidate) => candidate.command.id),
  );
  if (matchedCommandIds.size > 1) {
    return {
      ok: false,
      error: {
        code: "AMBIGUOUS_COMMAND",
        message: `Ambiguous command "/${parsed.commandLine}"`,
      },
    };
  }

  const candidate = bestCandidates[0];
  const matchedLength = candidateMatchedLength(candidate);
  return {
    ok: true,
    command: candidate.command,
    path: candidate.path,
    usedAlias: candidate.usedAlias,
    raw: parsed.raw,
    rawArgs: rawArgsFromToken(
      parsed.commandLine,
      parsed.tokenSpans[matchedLength],
    ),
    argv: parsed.segments.slice(matchedLength),
    body: parsed.body,
  };
}

function isVisibleOnSurface(
  command: UiSlashCommandSpec,
  surface?: UiSlashCommandSurface,
): boolean {
  return surface === undefined || command.surfaces.includes(surface);
}

function pathOrAliasMatches(
  command: UiSlashCommandSpec,
  query: string,
): boolean {
  const paths = [command.path, ...(command.aliases ?? [])];
  const normalizedQuery = normalizePartialPath(query);
  return paths.some((path) => normalizePath(path).startsWith(normalizedQuery));
}

export function filterSlashCommandCatalog(
  catalog: UiSlashCommandCatalog,
  partialInput: string,
  options: { readonly surface?: UiSlashCommandSurface } = {},
): UiSlashCommandSpec[] {
  const query = partialInput.startsWith("/")
    ? partialInput.slice(1).toLowerCase()
    : partialInput.toLowerCase();

  return catalog.commands
    .filter((command) => isVisibleOnSurface(command, options.surface))
    .filter((command) => pathOrAliasMatches(command, query))
    .sort((left, right) => {
      const leftPath = normalizePath(left.path);
      const rightPath = normalizePath(right.path);
      if (leftPath.length !== rightPath.length) {
        return leftPath.length - rightPath.length;
      }
      return leftPath.localeCompare(rightPath);
    });
}

export const resolveCommand = resolveSlashCommand;
export const filterCommandCatalog = filterSlashCommandCatalog;
