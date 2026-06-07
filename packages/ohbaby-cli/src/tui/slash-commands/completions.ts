import type { TuiCommandCatalog, TuiCommandSpec } from "../store/snapshot.js";
import {
  applySlashCompletion,
  filterCommandCatalog,
  parseSlashInput,
} from "./runtime.js";
import { COMMAND_HINT_LIMIT } from "./hints.js";

export function getSlashCompletion(
  input: string,
  catalog: TuiCommandCatalog | null,
): string {
  if (catalog === null) {
    return input;
  }

  return applySlashCompletion(input, catalog, { surface: "tui" });
}

export function getSlashCompletionCandidates(
  input: string,
  catalog: TuiCommandCatalog | null,
): readonly TuiCommandSpec[] {
  if (catalog === null) {
    return [];
  }

  return filterCommandCatalog(parseSlashInput(input), catalog, {
    surface: "tui",
  });
}

export function getSlashCompletionWindow(
  input: string,
  catalog: TuiCommandCatalog | null,
  selectedIndex: number,
): readonly TuiCommandSpec[] {
  const candidates = getSlashCompletionCandidates(input, catalog);
  const start = getSlashCompletionWindowStart(candidates.length, selectedIndex);

  return candidates.slice(start, start + COMMAND_HINT_LIMIT);
}

export function getSlashCompletionWindowStart(
  candidateCount: number,
  selectedIndex: number,
): number {
  if (candidateCount <= COMMAND_HINT_LIMIT) {
    return 0;
  }

  const normalizedIndex =
    ((Math.floor(selectedIndex) % candidateCount) + candidateCount) %
    candidateCount;

  return Math.min(
    Math.max(0, candidateCount - COMMAND_HINT_LIMIT),
    Math.floor(normalizedIndex / COMMAND_HINT_LIMIT) * COMMAND_HINT_LIMIT,
  );
}

export function getSlashCompletionPageIndex(
  candidateCount: number,
  selectedIndex: number,
  direction: "next" | "previous",
): number {
  if (candidateCount <= 0) {
    return 0;
  }

  const currentStart = getSlashCompletionWindowStart(
    candidateCount,
    selectedIndex,
  );
  const lastStart = getSlashCompletionWindowStart(
    candidateCount,
    candidateCount - 1,
  );

  if (direction === "next") {
    return currentStart >= lastStart
      ? 0
      : Math.min(candidateCount - 1, currentStart + COMMAND_HINT_LIMIT);
  }

  return currentStart === 0
    ? lastStart
    : Math.max(0, currentStart - COMMAND_HINT_LIMIT);
}
