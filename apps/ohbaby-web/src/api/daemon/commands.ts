import type { UiSlashCommandCatalog, UiSlashCommandSpec } from "ohbaby-sdk";

const WEB_PASSTHROUGH_COMMAND_IDS = new Set([
  "help",
  "mcps",
  "new",
  "skills",
  "status",
]);

export function isWebPassthroughCommandId(commandId: string): boolean {
  return WEB_PASSTHROUGH_COMMAND_IDS.has(commandId);
}

export function isWebPassthroughCommandSpec(
  command: UiSlashCommandSpec,
): boolean {
  return (
    isWebPassthroughCommandId(command.id) &&
    command.parentBehavior !== "interaction"
  );
}

export function filterWebPassthroughCommandCatalog(
  catalog: UiSlashCommandCatalog,
): UiSlashCommandCatalog {
  return {
    ...catalog,
    commands: catalog.commands.filter(isWebPassthroughCommandSpec),
  };
}
