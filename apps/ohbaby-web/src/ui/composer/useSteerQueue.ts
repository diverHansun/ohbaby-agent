import type { UiBackendClient, UiPromptSubmission } from "ohbaby-sdk";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  composerLeaseKey,
  type QueuedEditState,
  removeSessionValue,
  type StoredQueuedEdit,
  writeSessionValue,
} from "./draft-storage.js";
import type { ComposerDraftState } from "./useComposerDraft.js";

const LEASE_RENEWAL_INTERVAL_MS = 20_000;

/**
 * Editing queued or retained prompts under a server edit lease: acquiring,
 * renewing on activity, invalidating when the prompt changes, and finishing,
 * releasing or cancelling. The draft that was open before editing is restored
 * afterwards.
 */
export function useSteerQueue(input: {
  readonly client: Pick<
    UiBackendClient,
    | "acquirePromptEditLease"
    | "renewPromptEditLease"
    | "releasePromptEditLease"
    | "editQueuedPrompt"
    | "resubmitRetainedPrompt"
    | "cancelQueuedPrompt"
  >;
  readonly draftScopeKey: string;
  readonly queuedPrompts: readonly UiPromptSubmission[];
  readonly state: ComposerDraftState;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
}): {
  readonly beginQueuedEdit: (prompt: UiPromptSubmission) => void;
  readonly finishQueuedEdit: () => void;
  readonly releaseQueuedEdit: () => void;
  readonly cancelQueuedPrompt: (promptId: string) => void;
} {
  const { client, draftScopeKey, queuedPrompts, state, textareaRef } = input;
  const {
    draft,
    draftRef,
    queuedEdit,
    queuedEditRef,
    setQueuedEdit,
    setDraft,
    setPendingRequestId,
    setPendingText,
    pendingRequestId,
    pendingText,
    isSubmitting,
    setIsSubmitting,
    setQueueError,
    leaseActivityVersion,
    setLeaseActivityVersion,
    setQueueAcquirePending,
    queueAcquirePendingRef,
    queueAcquireGenerationRef,
    lastLeaseRenewalAt,
    draftScopeGeneration,
    persistDraft,
  } = state;
  const queuedPromptsRef = useRef(queuedPrompts);
  useLayoutEffect(() => {
    queuedPromptsRef.current = queuedPrompts;
  }, [queuedPrompts]);
  const leaseRenewalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return (): void => {
      if (leaseRenewalTimer.current !== null) {
        globalThis.clearTimeout(leaseRenewalTimer.current);
      }
    };
  }, []);

  /** Leaves edit mode and puts back the draft that was open before it. */
  const restoreOriginalDraft = useCallback(
    (edit: QueuedEditState): void => {
      setQueuedEdit(null);
      setDraft(edit.originalDraft);
      setPendingRequestId(edit.originalPendingRequestId ?? null);
      setPendingText(edit.originalPendingText ?? null);
      persistDraft(
        edit.originalDraft,
        edit.originalPendingRequestId,
        edit.originalPendingText,
      );
      removeSessionValue(composerLeaseKey(draftScopeKey));
    },
    [
      draftScopeKey,
      persistDraft,
      setDraft,
      setPendingRequestId,
      setPendingText,
      setQueuedEdit,
    ],
  );

  useEffect(() => {
    if (
      !queuedEdit ||
      queuedEdit.retainedSendText !== undefined ||
      leaseActivityVersion === 0
    )
      return;
    const generation = draftScopeGeneration.current;
    let cancelled = false;
    if (leaseRenewalTimer.current !== null) {
      globalThis.clearTimeout(leaseRenewalTimer.current);
    }
    const delay = Math.max(
      0,
      LEASE_RENEWAL_INTERVAL_MS - (Date.now() - lastLeaseRenewalAt.current),
    );
    leaseRenewalTimer.current = globalThis.setTimeout(() => {
      leaseRenewalTimer.current = null;
      void client
        .renewPromptEditLease({
          editLeaseId: queuedEdit.editLeaseId,
          promptId: queuedEdit.promptId,
        })
        .then((lease) => {
          if (
            cancelled ||
            generation !== draftScopeGeneration.current ||
            queuedEditRef.current?.retainedSendText !== undefined
          )
            return;
          lastLeaseRenewalAt.current = Date.now();
          setQueuedEdit((current) =>
            current?.editLeaseId === queuedEdit.editLeaseId
              ? { ...current, expiresAt: lease.expiresAt, leaseLost: false }
              : current,
          );
          writeSessionValue(composerLeaseKey(draftScopeKey), {
            ...queuedEdit,
            editText: draft,
            expiresAt: lease.expiresAt,
            lastActivityAt: Date.now(),
          } satisfies StoredQueuedEdit);
        })
        .catch(() => {
          if (
            cancelled ||
            generation !== draftScopeGeneration.current ||
            queuedEditRef.current?.retainedSendText !== undefined
          )
            return;
          setQueuedEdit((current) =>
            current?.editLeaseId === queuedEdit.editLeaseId
              ? { ...current, leaseLost: true }
              : current,
          );
          setQueueError(
            "Edit lease expired. Your edited text is preserved. Esc restores your draft.",
          );
        });
    }, delay);
    return (): void => {
      cancelled = true;
      if (leaseRenewalTimer.current !== null) {
        globalThis.clearTimeout(leaseRenewalTimer.current);
        leaseRenewalTimer.current = null;
      }
    };
  }, [
    client,
    draft,
    draftScopeGeneration,
    draftScopeKey,
    lastLeaseRenewalAt,
    leaseActivityVersion,
    queuedEdit,
    queuedEditRef,
    setQueueError,
    setQueuedEdit,
  ]);

  useEffect(() => {
    if (
      !queuedEdit ||
      queuedEdit.retainedSendText !== undefined ||
      queuedEdit.leaseLost ||
      isSubmitting
    )
      return;
    const prompt = queuedPrompts.find(
      (item) => item.promptId === queuedEdit.promptId,
    );
    const invalidate = (): void => {
      setQueuedEdit((current) =>
        current?.editLeaseId === queuedEdit.editLeaseId
          ? { ...current, leaseLost: true }
          : current,
      );
      setQueueError(
        "This edit is no longer available. Your text is preserved. Esc restores your draft.",
      );
    };
    if (!prompt || (queuedEdit.status && prompt.status !== queuedEdit.status)) {
      invalidate();
      return;
    }
    const delay = Date.parse(queuedEdit.expiresAt) - Date.now();
    if (delay <= 0) {
      invalidate();
      return;
    }
    const timer = globalThis.setTimeout(
      () => {
        if (Date.now() >= Date.parse(queuedEdit.expiresAt)) invalidate();
      },
      Math.min(delay, 2_147_483_647),
    );
    return (): void => {
      globalThis.clearTimeout(timer);
    };
  }, [queuedEdit, queuedPrompts, isSubmitting, setQueueError, setQueuedEdit]);

  const beginQueuedEdit = useCallback(
    (prompt: UiPromptSubmission): void => {
      if (queuedEdit || queueAcquirePendingRef.current) {
        setQueueError("Finish or cancel the current queued edit first.");
        return;
      }
      setQueueError(null);
      const acquireGeneration = queueAcquireGenerationRef.current + 1;
      queueAcquireGenerationRef.current = acquireGeneration;
      queueAcquirePendingRef.current = true;
      setQueueAcquirePending(true);
      void client
        .acquirePromptEditLease({ promptId: prompt.promptId })
        .then((lease) => {
          if (
            queueAcquireGenerationRef.current !== acquireGeneration ||
            !queuedPromptsRef.current.some(
              (item) =>
                item.promptId === prompt.promptId &&
                item.status === lease.prompt.status,
            )
          ) {
            void client
              .releasePromptEditLease({
                editLeaseId: lease.editLeaseId,
                promptId: prompt.promptId,
              })
              .catch(() => undefined);
            return;
          }
          const next: QueuedEditState = {
            editLeaseId: lease.editLeaseId,
            expiresAt: lease.expiresAt,
            status: lease.prompt.status === "retained" ? "retained" : "queued",
            operationId: globalThis.crypto.randomUUID(),
            originalDraft: draftRef.current,
            ...(pendingRequestId === null
              ? {}
              : { originalPendingRequestId: pendingRequestId }),
            ...(pendingText === null
              ? {}
              : { originalPendingText: pendingText }),
            promptId: prompt.promptId,
          };
          lastLeaseRenewalAt.current = Date.now();
          setLeaseActivityVersion(0);
          setQueuedEdit(next);
          setDraft(lease.prompt.text);
          setPendingRequestId(null);
          setPendingText(null);
          writeSessionValue(composerLeaseKey(draftScopeKey), {
            ...next,
            editText: lease.prompt.text,
            lastActivityAt: Date.now(),
          } satisfies StoredQueuedEdit);
          textareaRef.current?.focus();
        })
        .catch((error: unknown) => {
          if (queueAcquireGenerationRef.current === acquireGeneration) {
            setQueueError(
              error instanceof Error ? error.message : String(error),
            );
          }
        })
        .finally(() => {
          if (queueAcquireGenerationRef.current === acquireGeneration) {
            queueAcquirePendingRef.current = false;
            setQueueAcquirePending(false);
          }
        });
    },
    [
      client,
      draftRef,
      draftScopeKey,
      lastLeaseRenewalAt,
      pendingRequestId,
      pendingText,
      queueAcquireGenerationRef,
      queueAcquirePendingRef,
      queuedEdit,
      setDraft,
      setLeaseActivityVersion,
      setPendingRequestId,
      setPendingText,
      setQueueAcquirePending,
      setQueueError,
      setQueuedEdit,
      textareaRef,
    ],
  );

  const finishQueuedEdit = useCallback((): void => {
    if (
      !queuedEdit ||
      (queuedEdit.leaseLost && queuedEdit.retainedSendText === undefined) ||
      !draft.trim() ||
      isSubmitting
    )
      return;
    const generation = draftScopeGeneration.current;
    setIsSubmitting(true);
    setQueueError(null);
    const mutationInput = {
      editLeaseId: queuedEdit.editLeaseId,
      promptId: queuedEdit.promptId,
      text: queuedEdit.retainedSendText ?? draft.trim(),
    };
    const operationId =
      queuedEdit.operationId ?? globalThis.crypto.randomUUID();
    if (
      !queuedEdit.operationId ||
      (queuedEdit.status === "retained" &&
        queuedEdit.retainedSendText === undefined)
    ) {
      const next = {
        ...queuedEdit,
        operationId,
        ...(queuedEdit.status === "retained"
          ? { retainedSendText: mutationInput.text }
          : {}),
      };
      queuedEditRef.current = next;
      setQueuedEdit(next);
      writeSessionValue(composerLeaseKey(draftScopeKey), {
        ...next,
        editText: draft,
        lastActivityAt: Date.now(),
      } satisfies StoredQueuedEdit);
    }
    const mutation =
      queuedEdit.status === "retained"
        ? client.resubmitRetainedPrompt({ ...mutationInput, operationId })
        : client.editQueuedPrompt(mutationInput);
    void mutation
      .then(() => {
        if (
          generation !== draftScopeGeneration.current ||
          queuedEditRef.current?.editLeaseId !== queuedEdit.editLeaseId
        )
          return;
        restoreOriginalDraft(queuedEdit);
      })
      .catch((error: unknown) => {
        if (
          generation !== draftScopeGeneration.current ||
          queuedEditRef.current?.editLeaseId !== queuedEdit.editLeaseId
        )
          return;
        const message = error instanceof Error ? error.message : String(error);
        setQueueError(
          queuedEdit.status === "retained"
            ? `Send outcome unknown. Retry the same send to recover its receipt. ${message}. Esc restores your draft.`
            : message,
        );
      })
      .finally(() => {
        if (generation === draftScopeGeneration.current) setIsSubmitting(false);
      });
  }, [
    client,
    draft,
    draftScopeGeneration,
    draftScopeKey,
    isSubmitting,
    queuedEdit,
    queuedEditRef,
    restoreOriginalDraft,
    setIsSubmitting,
    setQueueError,
    setQueuedEdit,
  ]);

  const releaseQueuedEdit = useCallback((): void => {
    if (!queuedEdit) return;
    const current = queuedEdit;
    void client
      .releasePromptEditLease({
        editLeaseId: current.editLeaseId,
        promptId: current.promptId,
      })
      .catch(() => undefined);
    restoreOriginalDraft(current);
  }, [client, queuedEdit, restoreOriginalDraft]);

  const cancelQueuedPrompt = useCallback(
    (promptId: string): void => {
      const generation = draftScopeGeneration.current;
      const editLeaseId =
        queuedEdit?.promptId === promptId ? queuedEdit.editLeaseId : undefined;
      void client
        .cancelQueuedPrompt({
          ...(editLeaseId === undefined ? {} : { editLeaseId }),
          promptId,
        })
        .then(() => {
          if (generation !== draftScopeGeneration.current) return;
          if (
            queuedEdit?.promptId === promptId &&
            queuedEditRef.current?.editLeaseId === editLeaseId
          ) {
            restoreOriginalDraft(queuedEdit);
          }
        })
        .catch((error: unknown) => {
          if (generation !== draftScopeGeneration.current) return;
          setQueueError(error instanceof Error ? error.message : String(error));
        });
    },
    [
      client,
      draftScopeGeneration,
      queuedEdit,
      queuedEditRef,
      restoreOriginalDraft,
      setQueueError,
    ],
  );

  return {
    beginQueuedEdit,
    finishQueuedEdit,
    releaseQueuedEdit,
    cancelQueuedPrompt,
  };
}
