import type {
  SubmitPromptOptions,
  UiAcquirePromptEditLeaseInput,
  UiBackendClient,
  UiPromptCompletion,
  UiPromptEditLease,
  UiPromptReceipt,
  UiRenewPromptEditLeaseInput,
  UiEditQueuedPromptInput,
  UiCancelQueuedPromptInput,
  UiReleasePromptEditLeaseInput,
  UiPromptSubmission,
} from "ohbaby-sdk";
import type { UiPromptQueueExecutionPort } from "ohbaby-agent";
import type { DaemonClientViewCoordinator } from "./client-view.js";
import type { PermissionRouter } from "./permission-router.js";

export interface DaemonPromptItem {
  readonly clientId: string;
  readonly sessionId?: string;
  readonly text: string;
  readonly options?: SubmitPromptOptions;
}

export function acquirePromptEditLeaseForClient(
  backend: UiBackendClient & UiPromptQueueExecutionPort,
  input: UiAcquirePromptEditLeaseInput,
  trustedClientId: string,
): Promise<UiPromptEditLease> {
  return backend.acquirePromptEditLeaseForOwner(input, trustedClientId);
}

export function renewPromptEditLeaseForClient(
  backend: UiBackendClient & UiPromptQueueExecutionPort,
  input: UiRenewPromptEditLeaseInput,
  trustedClientId: string,
): Promise<UiPromptEditLease> {
  return backend.renewPromptEditLeaseForOwner(input, trustedClientId);
}

export function editQueuedPromptForClient(
  backend: UiBackendClient & UiPromptQueueExecutionPort,
  input: UiEditQueuedPromptInput,
  trustedClientId: string,
): Promise<UiPromptSubmission> {
  return backend.editQueuedPromptForOwner(input, trustedClientId);
}

export function cancelQueuedPromptForClient(
  backend: UiBackendClient & UiPromptQueueExecutionPort,
  input: UiCancelQueuedPromptInput,
  trustedClientId: string,
): Promise<UiPromptSubmission> {
  return backend.cancelQueuedPromptForOwner(input, trustedClientId);
}

export function releasePromptEditLeaseForClient(
  backend: UiBackendClient & UiPromptQueueExecutionPort,
  input: UiReleasePromptEditLeaseInput,
  trustedClientId: string,
): Promise<UiPromptSubmission> {
  return backend.releasePromptEditLeaseForOwner(input, trustedClientId);
}

export interface AcceptedDaemonPrompt {
  readonly completion: Promise<UiPromptCompletion>;
  readonly receipt: UiPromptReceipt;
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
 * Establish routing ownership before admission because a newly accepted
 * prompt may start synchronously and emit run/permission events before the
 * receipt is returned to the caller.
 */
export async function acceptDaemonPrompt(input: {
  readonly backend: UiBackendClient;
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
