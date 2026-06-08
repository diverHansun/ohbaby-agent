import type {
  UiSlashCommandCatalog,
  UiSlashCommandInvocation,
  UiSlashCommandSurface,
} from "./slash-command/types.js";
import type {
  UiCompactSessionOptions,
  UiCompactSessionResult,
} from "./compact.js";
import type { UiEvent } from "./events.js";
import type { UiInteractionResponse } from "./interaction.js";
import type { UiContextWindowUsage } from "./context-window.js";
import type {
  UiConnectModelInput,
  UiConnectModelResult,
} from "./connect-model.js";
import type { UiPermissionResponse, UiSnapshot } from "./snapshot.js";

export interface SubmitPromptOptions {
  readonly sessionId?: string;
}

export interface UiListCommandsQuery {
  readonly surface: UiSlashCommandSurface;
}

export type UiEventHandler = (event: UiEvent) => void;
export type UiUnsubscribe = () => void;

export interface UiBackendClient {
  getSnapshot(): Promise<UiSnapshot>;
  getContextWindowUsage(input: {
    readonly sessionId: string;
  }): Promise<UiContextWindowUsage | null>;
  subscribeEvents(handler: UiEventHandler): UiUnsubscribe;
  listCommands(query: UiListCommandsQuery): Promise<UiSlashCommandCatalog>;
  submitPrompt(text: string, options?: SubmitPromptOptions): Promise<void>;
  compactSession(
    options?: UiCompactSessionOptions,
  ): Promise<UiCompactSessionResult>;
  connectModel(input: UiConnectModelInput): Promise<UiConnectModelResult>;
  executeCommand(invocation: UiSlashCommandInvocation): Promise<void>;
  respondPermission(
    requestId: string,
    response: UiPermissionResponse,
  ): Promise<void>;
  respondInteraction(
    interactionId: string,
    response: UiInteractionResponse,
  ): Promise<void>;
  abortRun(runId?: string): Promise<void>;
}
