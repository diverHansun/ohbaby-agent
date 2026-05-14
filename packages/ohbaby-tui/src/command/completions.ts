import type {
  TuiCommandCatalog,
  TuiCommandSpec,
} from "../store/snapshot.js";
import {
  applySlashCompletion,
  filterCommandCatalog,
  parseSlashInput,
} from "./runtime.js";

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
