import type { UiCommandCatalog, UiCommandInvocation, UiCommandSurface } from "./command/types.js";
import type { UiEvent } from "./events.js";
import type { UiInteractionResponse } from "./interaction.js";
import type { UiPermissionResponse, UiSnapshot } from "./snapshot.js";

export interface SubmitPromptOptions {
  readonly sessionId?: string;
}

export interface UiListCommandsQuery {
  readonly surface: UiCommandSurface;
}

export type UiEventHandler = (event: UiEvent) => void;
export type UiUnsubscribe = () => void;

export interface UiBackendClient {
  getSnapshot(): Promise<UiSnapshot>;
  subscribeEvents(handler: UiEventHandler): UiUnsubscribe;
  listCommands(query: UiListCommandsQuery): Promise<UiCommandCatalog>;
  submitPrompt(text: string, options?: SubmitPromptOptions): Promise<void>;
  executeCommand(invocation: UiCommandInvocation): Promise<void>;
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

