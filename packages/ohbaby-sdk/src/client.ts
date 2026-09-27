import type { UiSubagentReadClient } from "./subagent.js";
import type {
  UiPermissionEvent,
  UiPermissionSnapshot,
  UiPermissionSnapshotQuery,
  UiPermissionResponseContext,
  UiSessionIndexEntry,
} from "./permission.js";
import type { UiReasoningConfig } from "./connect-model.js";
import type { UiSessionRecoveryClient } from "./session-view.js";
import type { UiSession } from "./snapshot.js";
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
  UiSteerQueuedPromptInput,
  UiSteerQueuedPromptReceipt,
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
  readonly reasoning?: UiReasoningConfig;
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

export interface UiQueryClient
  extends Partial<UiSessionRecoveryClient>, Partial<UiSubagentReadClient> {
  /** Explicit selection/startup barrier; never called by read endpoints. */
  initializeSession?(sessionId: string): Promise<void>;
  getSelectedSessionId(): Promise<string | null>;
  getSessionIndex(): Promise<readonly UiSessionIndexEntry[]>;
  getPermissionSnapshot(
    input: UiPermissionSnapshotQuery,
  ): Promise<UiPermissionSnapshot>;
  subscribePermissionEvents(
    handler: (event: UiPermissionEvent) => void,
    onError?: (error: unknown) => void,
  ): UiUnsubscribe;
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
  steerQueuedPrompt(
    input: UiSteerQueuedPromptInput,
  ): Promise<UiSteerQueuedPromptReceipt>;
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
  createSession(input?: {
    /** Preferred primary session to reuse when it is authoritatively empty. */
    readonly reuseSessionId?: string;
    /**
     * When present, any other authoritatively empty primary session in the
     * current project may be reused, except the listed ones (for example
     * sessions currently bound by other live clients).
     */
    readonly reuseInactiveEmpty?: {
      readonly excludeSessionIds: readonly string[];
    };
  }): Promise<UiSessionCreationResult>;
  selectSession(sessionId: string): Promise<void>;
  compactSession(
    options?: UiCompactSessionOptions,
  ): Promise<UiCompactSessionResult>;
  archiveSession(input: UiArchiveSessionInput): Promise<void>;
  updateSessionReasoning(input: {
    readonly sessionId: string;
    readonly reasoning: UiReasoningConfig | null;
  }): Promise<UiSession>;
  connectModel(input: UiConnectModelInput): Promise<UiConnectModelResult>;
  setSearchApiKey(
    input: UiSetSearchApiKeyInput,
  ): Promise<UiSetSearchApiKeyResult>;
  setPermission(input: UiPermissionUpdate): Promise<UiPermissionState>;
  executeCommand(invocation: UiSlashCommandInvocation): Promise<void>;
  respondPermission(
    requestId: string,
    response: UiPermissionResponse,
    context?: UiPermissionResponseContext,
  ): Promise<void>;
  respondInteraction(
    interactionId: string,
    response: UiInteractionResponse,
  ): Promise<void>;
  abortRun(runId: string): Promise<void>;
}

/** Outcome of a create request; `created` is omitted by older backends. */
export interface UiSessionCreationResult extends UiSessionIndexEntry {
  readonly created?: boolean;
}

/**
 * Complete production backend capability. Queue management is mandatory.
 */
export interface UiBackendClient extends UiQueryClient, UiCommandClient {}
