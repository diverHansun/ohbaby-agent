import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiPromptCompletion,
  UiPromptQueueClient,
  UiPromptReceipt,
} from "ohbaby-sdk";
import type { DaemonClientViewCoordinator } from "./client-view.js";
import type { PermissionRouter } from "./permission-router.js";

export interface DaemonPromptItem {
  readonly clientId: string;
  readonly sessionId?: string;
  readonly text: string;
  readonly options?: SubmitPromptOptions;
}

export function supportsPromptQueue(
  backend: UiBackendClient,
): backend is UiPromptQueueClient {
  const candidate = backend as Partial<UiPromptQueueClient>;
  return (
    typeof candidate.submitPromptAccepted === "function" &&
    typeof candidate.editQueuedPrompt === "function" &&
    typeof candidate.cancelQueuedPrompt === "function" &&
    typeof candidate.waitForPrompt === "function"
  );
}

export interface AcceptedDaemonPrompt {
  readonly completion: Promise<UiPromptCompletion>;
  readonly receipt: UiPromptReceipt;
}

export interface SubmittedDaemonPrompt {
  readonly completion: Promise<void>;
  readonly item: DaemonPromptItem;
}

function beginPromptOwnership(input: {
  readonly clientId: string;
  readonly clientViews: DaemonClientViewCoordinator;
  readonly createSessionId: () => string;
  readonly options?: SubmitPromptOptions;
  readonly permissionRouter: PermissionRouter;
  readonly text: string;
}): {
  readonly item: DaemonPromptItem;
  readonly release: () => void;
} {
  const prepared = input.clientViews.preparePromptSubmit(
    input.clientId,
    input.options,
    input.createSessionId,
  );
  const item: DaemonPromptItem = {
    clientId: input.clientId,
    ...(prepared.options === undefined ? {} : { options: prepared.options }),
    ...(prepared.sessionId === undefined
      ? {}
      : { sessionId: prepared.sessionId }),
    text: input.text,
  };
  const releasePermissionOwner = input.permissionRouter.trackPromptClient(
    item.clientId,
    item.sessionId,
  );
  input.clientViews.promptStarted(item);
  return {
    item,
    release: (): void => {
      input.clientViews.promptSettled(item);
      releasePermissionOwner();
    },
  };
}

/**
 * Compatibility path for injected/test backends that predate durable prompt
 * admission. It deliberately performs no scheduling: production backends use
 * WorkspacePromptScheduler as the only queue owner.
 */
export function submitDaemonPrompt(input: {
  readonly backend: UiBackendClient;
  readonly clientId: string;
  readonly clientViews: DaemonClientViewCoordinator;
  readonly createSessionId: () => string;
  readonly options?: SubmitPromptOptions;
  readonly permissionRouter: PermissionRouter;
  readonly text: string;
}): SubmittedDaemonPrompt {
  const started = beginPromptOwnership(input);
  const completion = Promise.resolve()
    .then(() =>
      input.backend.submitPrompt(started.item.text, started.item.options),
    )
    .finally(started.release);
  return { completion, item: started.item };
}

/**
 * Establish routing ownership before admission because a newly accepted
 * prompt may start synchronously and emit run/permission events before the
 * receipt is returned to the caller.
 */
export async function acceptDaemonPrompt(input: {
  readonly backend: UiPromptQueueClient;
  readonly clientId: string;
  readonly clientViews: DaemonClientViewCoordinator;
  readonly createSessionId: () => string;
  readonly options?: SubmitPromptOptions;
  readonly permissionRouter: PermissionRouter;
  readonly text: string;
}): Promise<AcceptedDaemonPrompt> {
  const started = beginPromptOwnership(input);
  try {
    const receipt = await input.backend.submitPromptAccepted(
      input.text,
      started.item.options,
    );
    const completion = input.backend
      .waitForPrompt(receipt.promptId)
      .finally(() => {
        started.release();
      });
    // Accepted transports may intentionally not await completion. Attach a
    // rejection observer so a disposal/network failure cannot become an
    // unhandled rejection; submit-and-wait callers still receive the original
    // rejecting promise.
    void completion.catch(() => undefined);
    return { completion, receipt };
  } catch (error) {
    started.release();
    throw error;
  }
}
