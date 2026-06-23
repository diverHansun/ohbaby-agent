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

export const WEB_OVERLAY_COMMAND_IDS = [
  "connect",
  "connect-search",
  "compact",
] as const;

export type UiWebOverlayCommandId = (typeof WEB_OVERLAY_COMMAND_IDS)[number];

export type UiWebCommandExecutionKind = "passthrough" | "overlay";

export type UiWebCommandAction =
  | "executeCommand"
  | "connectModel"
  | "connectSearch"
  | "compactSession";

export interface UiWebCommandSpec extends UiSlashCommandSpec {
  readonly action: UiWebCommandAction;
  readonly executionKind: UiWebCommandExecutionKind;
}

export interface UiWebCommandCatalog {
  readonly version: string;
  readonly commands: readonly UiWebCommandSpec[];
}

const WEB_PASSTHROUGH_COMMAND_ID_SET: ReadonlySet<string> = new Set(
  WEB_PASSTHROUGH_COMMAND_IDS,
);

const WEB_OVERLAY_COMMAND_ID_SET: ReadonlySet<string> = new Set(
  WEB_OVERLAY_COMMAND_IDS,
);

const WEB_OVERLAY_COMMAND_ACTIONS: ReadonlyMap<
  UiWebOverlayCommandId,
  Exclude<UiWebCommandAction, "executeCommand">
> = new Map([
  ["connect", "connectModel"],
  ["connect-search", "connectSearch"],
  ["compact", "compactSession"],
]);

const WEB_PASSTHROUGH_COMMAND_PATHS: ReadonlyMap<
  UiWebPassthroughCommandId,
  readonly string[]
> = new Map([
  ["help", ["help"]],
  ["mcps", ["mcps"]],
  ["new", ["new"]],
  ["skills", ["skills"]],
  ["status", ["status"]],
]);

const WEB_OVERLAY_COMMAND_PATHS: ReadonlyMap<
  UiWebOverlayCommandId,
  readonly string[]
> = new Map([
  ["connect", ["connect"]],
  ["connect-search", ["connect-search"]],
  ["compact", ["compact"]],
]);

export function isWebPassthroughCommandId(
  commandId: string,
): commandId is UiWebPassthroughCommandId {
  return WEB_PASSTHROUGH_COMMAND_ID_SET.has(commandId);
}

export function isWebOverlayCommandId(
  commandId: string,
): commandId is UiWebOverlayCommandId {
  return WEB_OVERLAY_COMMAND_ID_SET.has(commandId);
}

export function isWebPassthroughCommandSpec(
  command: UiSlashCommandSpec,
): boolean {
  if (!isWebPassthroughCommandId(command.id) || command.source !== "builtin") {
    return false;
  }
  const path = WEB_PASSTHROUGH_COMMAND_PATHS.get(command.id);
  return (
    path !== undefined &&
    hasSamePath(command.path, path) &&
    command.parentBehavior !== "interaction"
  );
}

export function isWebOverlayCommandSpec(
  command: UiSlashCommandSpec,
): command is UiSlashCommandSpec & { readonly id: UiWebOverlayCommandId } {
  if (!isWebOverlayCommandId(command.id) || command.source !== "builtin") {
    return false;
  }
  const path = WEB_OVERLAY_COMMAND_PATHS.get(command.id);
  return (
    path !== undefined &&
    hasSamePath(command.path, path)
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

export function filterWebCommandCatalog(
  catalog: UiSlashCommandCatalog,
  options: { readonly surface?: UiSlashCommandSurface } = {},
): UiWebCommandCatalog {
  const commands: UiWebCommandSpec[] = [];
  for (const command of catalog.commands) {
    if (!isVisibleOnSurface(command, options.surface)) {
      continue;
    }
    if (isWebPassthroughCommandSpec(command)) {
      commands.push({
        ...command,
        action: "executeCommand",
        executionKind: "passthrough",
      });
      continue;
    }
    if (isWebOverlayCommandSpec(command)) {
      const action = WEB_OVERLAY_COMMAND_ACTIONS.get(command.id);
      if (action === undefined) {
        continue;
      }
      commands.push({
        ...command,
        action,
        executionKind: "overlay",
      });
    }
  }
  return {
    version: catalog.version,
    commands,
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
