import type {
  SubmitPromptOptions,
  UiAcquirePromptEditLeaseInput,
  UiBackendClient,
  UiPromptCompletion,
  UiPromptEditLease,
  UiPromptReceipt,
  UiRenewPromptEditLeaseInput,
  UiEditQueuedPromptInput,
  UiResubmitRetainedPromptInput,
  UiPromptResubmissionReceipt,
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

export async function resubmitRetainedPromptForClient(
  backend: Pick<UiBackendClient, "getSnapshot" | "waitForPrompt"> &
    Pick<UiPromptQueueExecutionPort, "resubmitRetainedPromptForOwner">,
  input: UiResubmitRetainedPromptInput,
  trustedClientId: string,
  clientViews: Pick<
    DaemonClientViewCoordinator,
    "promptStarted" | "promptSettled"
  >,
): Promise<UiPromptResubmissionReceipt> {
  const prompt = (await backend.getSnapshot()).prompts?.find(
    (item) => item.promptId === input.promptId,
  );
  if (!prompt)
    throw Object.assign(new Error("Prompt not found"), {
      code: "PROMPT_NOT_FOUND",
    });
  const item: DaemonPromptItem = {
    clientId: trustedClientId,
    sessionId: prompt.sessionId,
    text: input.text,
  };
  // A re-admitted prompt can emit its first run event before returning a receipt.
  clientViews.promptStarted(item);
  try {
    const receipt = await backend.resubmitRetainedPromptForOwner(
      input,
      trustedClientId,
    );
    void backend
      .waitForPrompt(receipt.promptId)
      .finally(() => {
        clientViews.promptSettled(item);
      })
      .catch(() => undefined);
    return receipt;
  } catch (error) {
    clientViews.promptSettled(item);
    throw error;
  }
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
  readonly finishAdmission: (accepted: boolean) => void;
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
  input.clientViews.promptStarted(item);
  return {
    item,
    finishAdmission: prepared.finishAdmission,
    release: (): void => {
      input.clientViews.promptSettled(item);
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
  const target =
    input.options?.sessionId ??
    input.clientViews.binding(input.clientId, "prompt").rootSessionId ??
    undefined;
  const finishOperation = input.clientViews.beginSessionOperation(
    input.clientId,
    target,
  );
  try {
    if (input.options?.sessionId !== undefined) {
      const previous = input.clientViews.binding(input.clientId, "prompt");
      const sessions = await input.backend.getSessionIndex();
      const selected = sessions.find(
        (session) => session.id === input.options?.sessionId,
      );
      if (!selected || selected.parentId || selected.isSubagent)
        throw new Error("Prompt requires an available root session");
      input.clientViews.assertBinding(input.clientId, previous, "prompt");
    }
    const started = beginPromptOwnership(input);
    try {
      const receipt = await input.backend.submitPromptAccepted(
        input.text,
        started.item.options,
      );
      started.finishAdmission(true);
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
      started.finishAdmission(false);
      started.release();
      throw error;
    }
  } finally {
    finishOperation();
  }
}

export function steerQueuedPromptForClient(
  backend: UiBackendClient & UiPromptQueueExecutionPort,
  input: Parameters<UiBackendClient["steerQueuedPrompt"]>[0],
  trustedClientId: string,
): ReturnType<UiBackendClient["steerQueuedPrompt"]> {
  return backend.steerQueuedPromptForOwner(input, trustedClientId);
}

/** Skills use the same pre-admission owner reservation as ordinary prompts. */
export async function executeCommandForClient(input: {
  readonly backend: UiBackendClient;
  readonly clientId: string;
  readonly clientViews: DaemonClientViewCoordinator;
  readonly createSessionId: () => string;
  readonly permissionRouter: PermissionRouter;
  readonly invocation: Parameters<UiBackendClient["executeCommand"]>[0];
}): ReturnType<UiBackendClient["executeCommand"]> {
  const { invocation } = input;
  if (!invocation.commandId.startsWith("skill."))
    return input.backend.executeCommand(invocation);
  const target =
    invocation.sessionId ??
    input.clientViews.binding(input.clientId, "prompt").rootSessionId ??
    undefined;
  const finishOperation = input.clientViews.beginSessionOperation(
    input.clientId,
    target,
  );
  try {
    if (invocation.sessionId !== undefined) {
      const previous = input.clientViews.binding(input.clientId, "prompt");
      const sessions = await input.backend.getSessionIndex();
      const selected = sessions.find(
        (session) => session.id === invocation.sessionId,
      );
      if (!selected || selected.parentId || selected.isSubagent)
        throw new Error("Prompt requires an available root session");
      input.clientViews.assertBinding(input.clientId, previous, "prompt");
    }
    const started = beginPromptOwnership({
      ...input,
      options: {
        sessionId: invocation.sessionId,
        clientRequestId: invocation.clientRequestId,
      },
      text: invocation.raw,
    });
    try {
      const completion = await input.backend.executeCommand({
        ...invocation,
        sessionId: started.item.sessionId,
      });
      const receipt = completion.promptReceipt;
      started.finishAdmission(receipt !== undefined);
      if (receipt) {
        void input.backend
          .waitForPrompt(receipt.promptId)
          .finally(started.release)
          .catch(() => undefined);
      } else started.release();
      return completion;
    } catch (error) {
      started.finishAdmission(false);
      started.release();
      throw error;
    }
  } finally {
    finishOperation();
  }
}
