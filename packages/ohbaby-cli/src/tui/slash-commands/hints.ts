import type { TuiCommandSpec } from "../store/snapshot.js";

export const COMMAND_HINT_LIMIT = 6;
const COMMAND_HINT_MAX_LENGTH = 72;

export function formatCommandHint(command: TuiCommandSpec): string {
  return truncateHint(
    `${formatCommandUsage(command)} - ${command.description}`,
  );
}

export function formatCommandHints(
  commands: readonly TuiCommandSpec[],
): readonly string[] {
  return commands.slice(0, COMMAND_HINT_LIMIT).map(formatCommandHint);
}

function truncateHint(value: string): string {
  if (value.length <= COMMAND_HINT_MAX_LENGTH) {
    return value;
  }

  return `${value.slice(0, COMMAND_HINT_MAX_LENGTH - 3)}...`;
}

function formatCommandUsage(command: TuiCommandSpec): string {
  const path = `/${command.path.join(" ")}`;
  return command.argsHint ? `${path} ${command.argsHint}` : path;
}
