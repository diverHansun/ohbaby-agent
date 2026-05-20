import type { TuiCommandSpec } from "../store/snapshot.js";

export const COMMAND_HINT_LIMIT = 6;

export function formatCommandHint(command: TuiCommandSpec): string {
  return `/${command.path.join(" ")} - ${command.description}`;
}

export function formatCommandHints(
  commands: readonly TuiCommandSpec[],
): readonly string[] {
  return commands.slice(0, COMMAND_HINT_LIMIT).map(formatCommandHint);
}
