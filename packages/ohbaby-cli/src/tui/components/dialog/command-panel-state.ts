import type { UiCommandOutput } from "ohbaby-sdk";

export type CommandPanelKind = "status" | "help" | "mcps" | "models";

export type CommandPanelStatus = "loading" | "ready" | "error";

export interface CommandPanelState {
  readonly kind: CommandPanelKind;
  readonly mode: "display";
  readonly clientInvocationId: string;
  readonly openedAt: number;
  readonly sessionId: string | null;
  readonly status: CommandPanelStatus;
  readonly output?: UiCommandOutput;
  readonly error?: string;
}

const DISPLAY_COMMAND_IDS = new Set<CommandPanelKind>([
  "help",
  "mcps",
  "models",
  "status",
]);

export function displayPanelKindForCommandId(
  commandId: string,
): CommandPanelKind | null {
  return DISPLAY_COMMAND_IDS.has(commandId as CommandPanelKind)
    ? (commandId as CommandPanelKind)
    : null;
}
