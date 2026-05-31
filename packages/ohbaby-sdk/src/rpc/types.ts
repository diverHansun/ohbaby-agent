import type {
  SubmitPromptOptions,
  UiEventHandler,
  UiListCommandsQuery,
  UiUnsubscribe,
} from "../client.js";
import type {
  UiCommandCatalog,
  UiCommandInvocation,
} from "../command/types.js";
import type {
  UiCompactSessionOptions,
  UiCompactSessionResult,
} from "../compact.js";
import type { UiInteractionResponse } from "../interaction.js";
import type { UiPermissionResponse, UiSnapshot } from "../snapshot.js";

export interface CoreAPI {
  getSnapshot(): Promise<UiSnapshot>;
  listCommands(query: UiListCommandsQuery): Promise<UiCommandCatalog>;
  submitPrompt(text: string, options?: SubmitPromptOptions): Promise<void>;
  compactSession(
    options?: UiCompactSessionOptions,
  ): Promise<UiCompactSessionResult>;
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

export interface SDKAPI {
  subscribeEvents(handler: UiEventHandler): UiUnsubscribe;
}
