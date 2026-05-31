import type {
  UiCommandCatalog,
  UiCommandResolveOptions,
  UiCommandResolveResult,
  UiCommandSpec,
  UiCommandSurface,
  UiParsedSlashInput,
  UiSlashTokenSpan,
} from "./types.js";

interface MatchCandidate {
  readonly command: UiCommandSpec;
  readonly path: readonly string[];
  readonly usedAlias?: readonly string[];
}

function normalizePath(path: readonly string[]): string {
  return path.join("/").toLowerCase();
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

function unknownCommand(parsed: UiParsedSlashInput): UiCommandResolveResult {
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
  catalog: UiCommandCatalog,
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

export function resolveCommand(
  catalog: UiCommandCatalog,
  parsed: UiParsedSlashInput | null,
  options: UiCommandResolveOptions = {},
): UiCommandResolveResult {
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

  for (const candidate of candidates) {
    const matchedLength = candidate.usedAlias?.length ?? candidate.path.length;
    const hasRemainingArgs = parsed.segments.length > matchedLength;
    if (hasRemainingArgs && candidate.command.acceptsArguments !== true) {
      continue;
    }

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

  return unknownCommand(parsed);
}

function isVisibleOnSurface(
  command: UiCommandSpec,
  surface?: UiCommandSurface,
): boolean {
  return surface === undefined || command.surfaces.includes(surface);
}

function pathOrAliasMatches(command: UiCommandSpec, query: string): boolean {
  const paths = [command.path, ...(command.aliases ?? [])];
  return paths.some((path) => normalizePath(path).startsWith(query));
}

export function filterCommandCatalog(
  catalog: UiCommandCatalog,
  partialInput: string,
  options: { readonly surface?: UiCommandSurface } = {},
): UiCommandSpec[] {
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
