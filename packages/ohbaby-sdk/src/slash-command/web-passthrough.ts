import type {
  UiSlashCommandCatalog,
  UiSlashCommandInvocation,
  UiSlashCommandSpec,
  UiSlashCommandSurface,
} from "./types.js";

export const WEB_PASSTHROUGH_COMMAND_IDS = [
  "help",
  "mcps",
  "new",
  "skills",
  "status",
] as const;

export type UiWebPassthroughCommandId =
  (typeof WEB_PASSTHROUGH_COMMAND_IDS)[number];

const WEB_PASSTHROUGH_COMMAND_ID_SET: ReadonlySet<string> = new Set(
  WEB_PASSTHROUGH_COMMAND_IDS,
);

export function isWebPassthroughCommandId(
  commandId: string,
): commandId is UiWebPassthroughCommandId {
  return WEB_PASSTHROUGH_COMMAND_ID_SET.has(commandId);
}

export function isWebPassthroughCommandSpec(
  command: UiSlashCommandSpec,
): boolean {
  return (
    isWebPassthroughCommandId(command.id) &&
    command.parentBehavior !== "interaction"
  );
}

function isVisibleOnSurface(
  command: UiSlashCommandSpec,
  surface?: UiSlashCommandSurface,
): boolean {
  return surface === undefined || command.surfaces.includes(surface);
}

export function filterWebPassthroughCommandCatalog(
  catalog: UiSlashCommandCatalog,
  options: { readonly surface?: UiSlashCommandSurface } = {},
): UiSlashCommandCatalog {
  return {
    ...catalog,
    commands: catalog.commands.filter(
      (command) =>
        isVisibleOnSurface(command, options.surface) &&
        isWebPassthroughCommandSpec(command),
    ),
  };
}

function hasSamePath(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

export function supportsWebPassthroughCommandInvocation(
  catalog: UiSlashCommandCatalog,
  invocation: UiSlashCommandInvocation,
): boolean {
  return catalog.commands.some(
    (command) =>
      command.id === invocation.commandId &&
      isVisibleOnSurface(command, invocation.surface) &&
      hasSamePath(command.path, invocation.path) &&
      isWebPassthroughCommandSpec(command),
  );
}
