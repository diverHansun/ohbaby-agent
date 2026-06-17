import type { UiCommandOutput } from "ohbaby-sdk";

export type DisplayCommandPanelKind =
  | "status"
  | "help"
  | "mcps"
  | "models"
  | "skills";

export type InteractiveCommandPanelKind = "connect" | "connect-search";

export type CommandPanelKind =
  | DisplayCommandPanelKind
  | InteractiveCommandPanelKind;

export type CommandPanelStatus = "loading" | "ready" | "error";

export interface DisplayCommandPanelState {
  readonly kind: DisplayCommandPanelKind;
  readonly mode: "display";
  readonly clientInvocationId: string;
  readonly openedAt: number;
  readonly sessionId: string | null;
  readonly status: CommandPanelStatus;
  readonly output?: UiCommandOutput;
  readonly error?: string;
}

export interface InteractiveCommandPanelState {
  readonly kind: InteractiveCommandPanelKind;
  readonly mode: "interactive";
  readonly openedAt: number;
  readonly sessionId: string | null;
}

export type CommandPanelState =
  | DisplayCommandPanelState
  | InteractiveCommandPanelState;

const DISPLAY_COMMAND_IDS = new Set<DisplayCommandPanelKind>([
  "help",
  "mcps",
  "models",
  "skills",
  "status",
]);

const INTERACTIVE_COMMAND_IDS = new Set<InteractiveCommandPanelKind>([
  "connect",
  "connect-search",
]);

export function displayPanelKindForCommandId(
  commandId: string,
): DisplayCommandPanelKind | null {
  return DISPLAY_COMMAND_IDS.has(commandId as DisplayCommandPanelKind)
    ? (commandId as DisplayCommandPanelKind)
    : null;
}

export function interactivePanelKindForCommandId(
  commandId: string,
): InteractiveCommandPanelKind | null {
  return INTERACTIVE_COMMAND_IDS.has(commandId as InteractiveCommandPanelKind)
    ? (commandId as InteractiveCommandPanelKind)
    : null;
}
