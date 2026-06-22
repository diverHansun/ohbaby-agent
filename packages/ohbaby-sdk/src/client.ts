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
  UiCurrentModelConfig,
  UiConnectModelInput,
  UiConnectModelResult,
  UiProbeModelContextWindowInput,
  UiProbeModelContextWindowResult,
} from "./connect-model.js";
import type {
  UiSetSearchApiKeyInput,
  UiSetSearchApiKeyResult,
} from "./connect-search.js";
import type { UiPermissionResponse, UiSnapshot } from "./snapshot.js";
import type {
  UiPermissionLevel,
  UiPermissionMode,
  UiPermissionState,
} from "./snapshot.js";

export interface SubmitPromptOptions {
  readonly sessionId?: string;
}

export interface UiPermissionUpdate {
  readonly level?: UiPermissionLevel;
  readonly mode?: UiPermissionMode;
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
