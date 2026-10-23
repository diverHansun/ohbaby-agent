import type { UiBackendClient } from "ohbaby-sdk";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  composerDraftKey,
  composerLeaseKey,
  type QueuedEditState,
  readSessionValue,
  type StoredComposerDraft,
  type StoredQueuedEdit,
  writeSessionValue,
} from "./draft-storage.js";

export interface ComposerPrefill {
  readonly scopeKey: string;
  readonly editRevision: number;
  readonly nonce: number;
  readonly text: string;
}

/** Draft state shared by the composer's send path and the queued-edit lease hook. */
export interface ComposerDraftState {
  readonly draft: string;
  readonly setDraft: Dispatch<SetStateAction<string>>;
  readonly draftRef: RefObject<string>;
  readonly pendingRequestId: string | null;
  readonly setPendingRequestId: Dispatch<SetStateAction<string | null>>;
  readonly pendingText: string | null;
  readonly setPendingText: Dispatch<SetStateAction<string | null>>;
  readonly queuedEdit: QueuedEditState | null;
  readonly setQueuedEdit: Dispatch<SetStateAction<QueuedEditState | null>>;
  readonly queuedEditRef: RefObject<QueuedEditState | null>;
  readonly isSubmitting: boolean;
  readonly setIsSubmitting: Dispatch<SetStateAction<boolean>>;
  readonly queueError: string | null;
  readonly setQueueError: Dispatch<SetStateAction<string | null>>;
  readonly resendError: string | null;
  readonly setResendError: Dispatch<SetStateAction<string | null>>;
  readonly leaseActivityVersion: number;
  readonly setLeaseActivityVersion: Dispatch<SetStateAction<number>>;
  readonly queueAcquirePending: boolean;
  readonly setQueueAcquirePending: Dispatch<SetStateAction<boolean>>;
  readonly queueAcquirePendingRef: RefObject<boolean>;
  readonly queueAcquireGenerationRef: RefObject<number>;
  readonly lastLeaseRenewalAt: RefObject<number>;
  readonly queueExpanded: boolean;
  readonly setQueueExpanded: Dispatch<SetStateAction<boolean>>;
  /** Bumped whenever the scope changes, so late async results are dropped. */
  readonly draftScopeGeneration: RefObject<number>;
  /** Bumped on every user edit, so late results never overwrite newer text. */
  readonly editRevision: RefObject<number>;
  readonly persistDraft: (
    text: string,
    requestId?: string,
    requestText?: string,
  ) => void;
  readonly updateDraft: (nextDraft: string) => void;
}

/**
 * Owns the composer draft for one scope: restoring it (and any queued-edit
 * lease) from session storage, persisting edits and applying prefills.
 */
export function useComposerDraft(input: {
  readonly client: Pick<UiBackendClient, "renewPromptEditLease">;
  readonly draftScopeKey: string;
  readonly onEditRevision: (revision: number) => void;
  readonly prefill?: ComposerPrefill | null;
  readonly onPrefilled: () => void;
}): ComposerDraftState {
  const { client, draftScopeKey } = input;
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [queuedEdit, setQueuedEdit] = useState<QueuedEditState | null>(null);
  const [leaseActivityVersion, setLeaseActivityVersion] = useState(0);
  const [queueAcquirePending, setQueueAcquirePending] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const draftRef = useRef("");
  const queuedEditRef = useRef(queuedEdit);
  useLayoutEffect(() => {
    draftRef.current = draft;
    queuedEditRef.current = queuedEdit;
  }, [draft, queuedEdit]);
  const draftScopeGeneration = useRef(0);
  const editRevision = useRef(0);
  const consumedPrefillNonce = useRef(0);
  const lastLeaseRenewalAt = useRef(0);
  const queueAcquirePendingRef = useRef(false);
  const queueAcquireGenerationRef = useRef(0);
  const onEditRevisionRef = useRef(input.onEditRevision);
  useLayoutEffect(() => {
    onEditRevisionRef.current = input.onEditRevision;
  }, [input.onEditRevision]);
  const advanceEditRevision = useCallback((): void => {
    editRevision.current += 1;
    onEditRevisionRef.current(editRevision.current);
  }, []);
  useLayoutEffect(
    () => (): void => {
      draftScopeGeneration.current += 1;
      queueAcquireGenerationRef.current += 1;
    },
    [],
  );

  useLayoutEffect(() => {
    draftScopeGeneration.current += 1;
    const generation = draftScopeGeneration.current;
    advanceEditRevision();
    setIsSubmitting(false);
    const stored = readSessionValue(
      composerDraftKey(draftScopeKey),
    ) as StoredComposerDraft | null;
    draftRef.current = stored?.text ?? "";
    setDraft(draftRef.current);
    setPendingRequestId(stored?.clientRequestId ?? null);
    setPendingText(stored?.pendingText ?? null);
    setQueueExpanded(false);
    queueAcquireGenerationRef.current += 1;
    queueAcquirePendingRef.current = false;
    setQueueAcquirePending(false);
    setQueueError(null);
    setResendError(null);
    setLeaseActivityVersion(0);

    const storedLease = readSessionValue(
      composerLeaseKey(draftScopeKey),
    ) as StoredQueuedEdit | null;
    if (!storedLease) {
      setQueuedEdit(null);
      return;
    }
    draftRef.current = storedLease.editText;
    setDraft(storedLease.editText);
    setQueuedEdit({ ...storedLease, leaseLost: true });
    if (storedLease.retainedSendText !== undefined) {
      setQueueError(
        "Send outcome unknown. Retry the same send to recover its receipt. Esc restores your draft.",
      );
      return;
    }
    void client
      .renewPromptEditLease({
        editLeaseId: storedLease.editLeaseId,
        promptId: storedLease.promptId,
      })
      .then((lease) => {
        const current = queuedEditRef.current;
        if (
          generation !== draftScopeGeneration.current ||
          current?.editLeaseId !== storedLease.editLeaseId
        )
          return;
        setQueuedEdit({
          ...current,
          status: lease.prompt.status === "retained" ? "retained" : "queued",
          expiresAt: lease.expiresAt,
          leaseLost: false,
        });
        lastLeaseRenewalAt.current = Date.now();
        const storedNow = readSessionValue(
          composerLeaseKey(draftScopeKey),
        ) as StoredQueuedEdit | null;
        writeSessionValue(composerLeaseKey(draftScopeKey), {
          ...current,
          editText: draftRef.current,
          expiresAt: lease.expiresAt,
          lastActivityAt: storedNow?.lastActivityAt ?? Date.now(),
        } satisfies StoredQueuedEdit);
      })
      .catch(() => {
        if (
          generation !== draftScopeGeneration.current ||
          queuedEditRef.current?.editLeaseId !== storedLease.editLeaseId
        )
          return;
        setQueuedEdit((current) =>
          current ? { ...current, leaseLost: true } : current,
        );
        setQueueError(
          "Edit lease expired. Your edited text is preserved. Esc restores your draft.",
        );
      });
  }, [client, draftScopeKey, advanceEditRevision]);

  const persistDraft = useCallback(
    (text: string, requestId?: string, requestText?: string): void => {
      writeSessionValue(composerDraftKey(draftScopeKey), {
        ...(requestId === undefined ? {} : { clientRequestId: requestId }),
        ...(requestText === undefined ? {} : { pendingText: requestText }),
        text,
      } satisfies StoredComposerDraft);
    },
    [draftScopeKey],
  );

  const updateDraft = useCallback(
    (nextDraft: string): void => {
      if (queuedEdit?.retainedSendText !== undefined) return;
      advanceEditRevision();
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      const keepPending =
        pendingRequestId !== null && pendingText === nextDraft.trim();
      if (!keepPending) {
        setPendingRequestId(null);
        setPendingText(null);
      }
      if (!queuedEdit)
        persistDraft(
          nextDraft,
          keepPending ? pendingRequestId : undefined,
          keepPending ? pendingText : undefined,
        );
      if (queuedEdit) {
        setLeaseActivityVersion((version) => version + 1);
        writeSessionValue(composerLeaseKey(draftScopeKey), {
          ...queuedEdit,
          editText: nextDraft,
          lastActivityAt: Date.now(),
        } satisfies StoredQueuedEdit);
      }
    },
    [
      advanceEditRevision,
      pendingRequestId,
      pendingText,
      persistDraft,
      draftScopeKey,
      queuedEdit,
    ],
  );

  const onPrefilledRef = useRef(input.onPrefilled);
  useLayoutEffect(() => {
    onPrefilledRef.current = input.onPrefilled;
  }, [input.onPrefilled]);
  useEffect(() => {
    const prefill = input.prefill;
    if (!prefill || prefill.nonce <= consumedPrefillNonce.current) return;
    consumedPrefillNonce.current = prefill.nonce;
    if (
      prefill.scopeKey !== draftScopeKey ||
      prefill.editRevision !== editRevision.current
    )
      return;
    updateDraft(prefill.text);
    onPrefilledRef.current();
  }, [draftScopeKey, input.prefill, updateDraft]);

  return {
    draft,
    setDraft,
    draftRef,
    pendingRequestId,
    setPendingRequestId,
    pendingText,
    setPendingText,
    queuedEdit,
    setQueuedEdit,
    queuedEditRef,
    isSubmitting,
    setIsSubmitting,
    queueError,
    setQueueError,
    resendError,
    setResendError,
    leaseActivityVersion,
    setLeaseActivityVersion,
    queueAcquirePending,
    setQueueAcquirePending,
    queueAcquirePendingRef,
    queueAcquireGenerationRef,
    lastLeaseRenewalAt,
    queueExpanded,
    setQueueExpanded,
    draftScopeGeneration,
    editRevision,
    persistDraft,
    updateDraft,
  };
}
