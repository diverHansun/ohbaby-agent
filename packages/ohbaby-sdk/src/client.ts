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
import type {
  UiCancelQueuedPromptInput,
  UiAcquirePromptEditLeaseInput,
  UiEditQueuedPromptInput,
  UiPromptCompletion,
  UiPromptReceipt,
  UiPromptEditLease,
  UiReleasePromptEditLeaseInput,
  UiRenewPromptEditLeaseInput,
  UiPromptSubmission,
} from "./prompt.js";

export interface SubmitPromptOptions {
  readonly clientRequestId?: string;
  readonly sessionId?: string;
}

export interface UiWaitForPromptOptions {
  readonly signal?: AbortSignal;
}

export interface UiSubmitPromptAndWaitOptions extends SubmitPromptOptions {
  readonly signal?: AbortSignal;
}

export async function submitPromptAndWait(
  client: {
    submitPromptAccepted(
      text: string,
      options?: SubmitPromptOptions,
    ): Promise<UiPromptReceipt>;
    waitForPrompt(
      promptId: string,
      options?: UiWaitForPromptOptions,
    ): Promise<UiPromptCompletion>;
  },
  text: string,
  options?: UiSubmitPromptAndWaitOptions,
): Promise<UiPromptCompletion> {
  const { signal, ...submitOptions } = options ?? {};
  const receipt = await client.submitPromptAccepted(text, submitOptions);
  return client.waitForPrompt(receipt.promptId, { signal });
}

export interface UiArchiveSessionInput {
  readonly sessionId: string;
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

export interface UiQueryClient {
  getSnapshot(): Promise<UiSnapshot>;
  getContextWindowUsage(input: {
    readonly sessionId: string;
  }): Promise<UiContextWindowUsage | null>;
  subscribeEvents(handler: UiEventHandler): UiUnsubscribe;
  listCommands(query: UiListCommandsQuery): Promise<UiSlashCommandCatalog>;
  waitForPrompt(
    promptId: string,
    options?: UiWaitForPromptOptions,
  ): Promise<UiPromptCompletion>;
  getCurrentModel(): Promise<UiCurrentModelConfig | null>;
  probeModelContextWindow(
    input: UiProbeModelContextWindowInput,
  ): Promise<UiProbeModelContextWindowResult>;
}

export interface UiPromptCommandClient {
  submitPromptAccepted(
    text: string,
    options?: SubmitPromptOptions,
  ): Promise<UiPromptReceipt>;
  submitPromptAndWait(
    text: string,
    options?: UiSubmitPromptAndWaitOptions,
  ): Promise<UiPromptCompletion>;
}

export interface UiPromptQueueCommandClient {
  editQueuedPrompt(input: UiEditQueuedPromptInput): Promise<UiPromptSubmission>;
  cancelQueuedPrompt(
    input: UiCancelQueuedPromptInput,
  ): Promise<UiPromptSubmission>;
  acquirePromptEditLease(
    input: UiAcquirePromptEditLeaseInput,
  ): Promise<UiPromptEditLease>;
  renewPromptEditLease(
    input: UiRenewPromptEditLeaseInput,
  ): Promise<UiPromptEditLease>;
  releasePromptEditLease(
    input: UiReleasePromptEditLeaseInput,
  ): Promise<UiPromptSubmission>;
}

export interface UiCommandClient
  extends UiPromptCommandClient, UiPromptQueueCommandClient {
  compactSession(
    options?: UiCompactSessionOptions,
  ): Promise<UiCompactSessionResult>;
  archiveSession(input: UiArchiveSessionInput): Promise<void>;
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
  abortRun(runId: string): Promise<void>;
}

/**
 * Complete production backend capability. Queue management is mandatory.
 */
export interface UiBackendClient extends UiQueryClient, UiCommandClient {}
