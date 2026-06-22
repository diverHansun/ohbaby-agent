import type {
  SubmitPromptOptions,
  UiEventHandler,
  UiListCommandsQuery,
  UiPermissionUpdate,
  UiUnsubscribe,
} from "../client.js";
import type {
  UiSlashCommandCatalog,
  UiSlashCommandInvocation,
} from "../slash-command/types.js";
import type {
  UiCompactSessionOptions,
  UiCompactSessionResult,
} from "../compact.js";
import type { UiInteractionResponse } from "../interaction.js";
import type { UiContextWindowUsage } from "../context-window.js";
import type {
  UiCurrentModelConfig,
  UiConnectModelInput,
  UiConnectModelResult,
  UiProbeModelContextWindowInput,
  UiProbeModelContextWindowResult,
} from "../connect-model.js";
import type {
  UiSetSearchApiKeyInput,
  UiSetSearchApiKeyResult,
} from "../connect-search.js";
import type {
  UiPermissionResponse,
  UiPermissionState,
  UiSnapshot,
} from "../snapshot.js";

export interface CoreAPI {
  getSnapshot(): Promise<UiSnapshot>;
  getContextWindowUsage(input: {
    readonly sessionId: string;
  }): Promise<UiContextWindowUsage | null>;
  listCommands(query: UiListCommandsQuery): Promise<UiSlashCommandCatalog>;
  submitPrompt(text: string, options?: SubmitPromptOptions): Promise<void>;
  compactSession(
    options?: UiCompactSessionOptions,
  ): Promise<UiCompactSessionResult>;
  getCurrentModel(): Promise<UiCurrentModelConfig | null>;
  probeModelContextWindow(
    input: UiProbeModelContextWindowInput,
  ): Promise<UiProbeModelContextWindowResult>;
  connectModel(input: UiConnectModelInput): Promise<UiConnectModelResult>;
  setSearchApiKey(
    input: UiSetSearchApiKeyInput,
  ): Promise<UiSetSearchApiKeyResult>;
  setPermission(input: UiPermissionUpdate): Promise<UiPermissionState>;
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

export interface SDKAPI {
  subscribeEvents(handler: UiEventHandler): UiUnsubscribe;
}
