import type { TuiCommandSpec } from "../store/snapshot.js";

const HINT_LIMIT = 5;

export function formatCommandHint(command: TuiCommandSpec): string {
  return `/${command.path.join(" ")} - ${command.description}`;
}

export function formatCommandHints(
  commands: readonly TuiCommandSpec[],
): readonly string[] {
  return commands.slice(0, HINT_LIMIT).map(formatCommandHint);
}
