import { SteerButton } from "./SteerButton.js";
import { LoaderCircle, Pencil, Send, Square, Trash2 } from "lucide-react";
import type {
  UiBackendClient,
  UiPermissionLevel,
  UiPermissionMode,
  UiPromptSubmission,
  UiReasoningConfig,
  UiSession,
  UiWebCommandCatalog,
} from "ohbaby-sdk";
import type {
  ChangeEvent,
  KeyboardEvent,
  ReactElement,
  ReactNode,
} from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createSlashPaletteItems,
  selectedSlashItem,
  slashCompletionSuffix,
  type SlashPaletteItem,
} from "../commands/slashCommands.js";
import { SlashPalette } from "../commands/SlashPalette.js";
import { type StructuredCommandRequest } from "../commands/StructuredCommandOverlay.js";

import { fitComposerTextarea } from "./composerTextarea.js";
import {
  composerDraftKey,
  composerLeaseKey,
  type QueuedEditState,
  readSessionValue,
  removeSessionValue,
  type StoredComposerDraft,
  type StoredQueuedEdit,
  writeSessionValue,
} from "./draft-storage.js";
import { isImeComposing } from "./ime.js";
import { ReasoningControl } from "./ReasoningControl.js";
import {
  COMPOSER_PLACEHOLDER_PHRASES,
  TypewriterPlaceholder,
} from "./TypewriterPlaceholder.js";

export interface ComposerModel {
  readonly activeRunId?: string;
  readonly activeRunStartedAt?: string;
  readonly activeSessionId?: string;
  readonly canSend: boolean;
  readonly canStop: boolean;
  readonly disabled: boolean;
  readonly isRunning: boolean;
  readonly mode: UiPermissionMode;
  readonly permissionLevel: UiPermissionLevel;
}

export interface ComposerPrefill {
  readonly scopeKey: string;
  readonly editRevision: number;
  readonly nonce: number;
  readonly text: string;
}

export function Composer(props: {
  readonly client: Pick<
    UiBackendClient,
    | "acquirePromptEditLease"
    | "renewPromptEditLease"
    | "releasePromptEditLease"
    | "editQueuedPrompt"
    | "resubmitRetainedPrompt"
    | "cancelQueuedPrompt"
    | "steerQueuedPrompt"
    | "getCurrentModel"
    | "subscribeEvents"
    | "updateSessionReasoning"
  >;
  readonly compact?: boolean;
  readonly unsentSteer?: boolean;
  readonly readOnly?: boolean;
  readonly draftScopeKey: string;
  readonly isPromptAdmitting: boolean;
  readonly onListCommands: () => Promise<UiWebCommandCatalog>;
  readonly onSetPermission: (input: {
    readonly level?: UiPermissionLevel;
    readonly mode?: UiPermissionMode;
  }) => void;
  readonly onStructuredCommand: (request: StructuredCommandRequest) => void;
  readonly onStop: () => void;
  readonly stopLabel?: string;
  readonly onSubmit: (
    text: string,
    clientRequestId?: string,
    reasoning?: UiReasoningConfig,
  ) => Promise<boolean>;
  readonly prefill?: ComposerPrefill | null;
  readonly onEditRevision: (revision: number) => void;
  readonly model: ComposerModel;
  readonly activeSession: UiSession | null;
  readonly queuedPrompts: readonly UiPromptSubmission[];
  readonly commandCatalogVersion: string | null;
  readonly connectionKind: string;
  readonly topContent: ReactNode;
  readonly permissionControl: ReactNode;
}): ReactElement {
  const selectedReasoning = useRef<UiReasoningConfig | undefined>(undefined);
  useEffect(() => {
    selectedReasoning.current = undefined;
  }, [props.activeSession?.id, props.client]);
  const [steerNoticeRunId, setSteerNoticeRunId] = useState<string>();
  const currentSteerTarget = useRef(props.model);
  useLayoutEffect(() => {
    currentSteerTarget.current = props.model;
  }, [props.model]);
  useEffect(() => {
    setSteerNoticeRunId(undefined);
  }, [props.model.activeSessionId, props.model.activeRunId]);
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [queuedEdit, setQueuedEdit] = useState<QueuedEditState | null>(null);
  const [leaseActivityVersion, setLeaseActivityVersion] = useState(0);
  const [queueAcquirePending, setQueueAcquirePending] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [slashCatalog, setSlashCatalog] = useState<UiWebCommandCatalog | null>(
    null,
  );
  const [slashDismissedDraft, setSlashDismissedDraft] = useState<string | null>(
    null,
  );
  const [slashError, setSlashError] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerInputRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef("");
  const queuedEditRef = useRef(queuedEdit);
  const queuedPromptsRef = useRef(props.queuedPrompts);
  useLayoutEffect(() => {
    queuedPromptsRef.current = props.queuedPrompts;
    draftRef.current = draft;
    queuedEditRef.current = queuedEdit;
  }, [draft, queuedEdit, props.queuedPrompts]);
  const draftScopeGeneration = useRef(0);
  const editRevision = useRef(0);
  const consumedPrefillNonce = useRef(0);
  const onEditRevisionRef = useRef(props.onEditRevision);
  useLayoutEffect(() => {
    onEditRevisionRef.current = props.onEditRevision;
  }, [props.onEditRevision]);
  const advanceEditRevision = useCallback((): void => {
    editRevision.current += 1;
    setSteerNoticeRunId(undefined);
    onEditRevisionRef.current(editRevision.current);
  }, []);
  useLayoutEffect(
    () => (): void => {
      draftScopeGeneration.current += 1;
      queueAcquireGenerationRef.current += 1;
    },
    [],
  );
  const lastEscapeAt = useRef(0);
  const lastLeaseRenewalAt = useRef(0);
  const leaseRenewalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueAcquirePendingRef = useRef(false);
  const queueAcquireGenerationRef = useRef(0);
  const canSend =
    props.model.canSend &&
    (!queuedEdit?.leaseLost || queuedEdit.retainedSendText !== undefined) &&
    draft.trim().length > 0 &&
    !isSubmitting &&
    !props.isPromptAdmitting;
  const showStop =
    props.stopLabel !== undefined ||
    (!queuedEdit &&
      ((props.model.isRunning && draft.trim().length === 0) ||
        (props.model.canStop &&
          (!props.model.canSend || draft.trim().length === 0))));
  const canUseSlash =
    props.model.canSend &&
    !queuedEdit &&
    !isSubmitting &&
    !props.isPromptAdmitting;
  const visibleQueuedPrompts = queueExpanded
    ? props.queuedPrompts
    : props.queuedPrompts.slice(0, 5);
  const slashItems = useMemo(
    () =>
      canUseSlash && slashCatalog && draft.startsWith("/")
        ? createSlashPaletteItems(slashCatalog, draft)
        : [],
    [canUseSlash, draft, slashCatalog],
  );
  const selectedCommand = selectedSlashItem(slashItems, slashIndex);
  const completionSuffix = slashCompletionSuffix(selectedCommand, draft);
  const slashOpen =
    draft.startsWith("/") &&
    slashDismissedDraft !== draft &&
    slashItems.length > 0 &&
    canUseSlash &&
    !props.model.disabled;
  const showTypewriterPlaceholder =
    !isFocused &&
    draft.length === 0 &&
    !isSubmitting &&
    !props.model.disabled &&
    !props.model.isRunning;

  useLayoutEffect(() => {
    draftScopeGeneration.current += 1;
    const generation = draftScopeGeneration.current;
    advanceEditRevision();
    setIsSubmitting(false);
    const stored = readSessionValue(
      composerDraftKey(props.draftScopeKey),
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
    setLeaseActivityVersion(0);

    const storedLease = readSessionValue(
      composerLeaseKey(props.draftScopeKey),
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
    void props.client
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
          composerLeaseKey(props.draftScopeKey),
        ) as StoredQueuedEdit | null;
        writeSessionValue(composerLeaseKey(props.draftScopeKey), {
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
  }, [props.client, props.draftScopeKey, advanceEditRevision]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    fitComposerTextarea(textarea, { lineHeight: 22, maxLines: 7 });
  }, [draft, props.model.disabled, slashOpen]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const composerInput = composerInputRef.current;
    if (!textarea || !composerInput || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      fitComposerTextarea(textarea, { lineHeight: 22, maxLines: 7 });
    });
    observer.observe(composerInput);
    return (): void => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    return (): void => {
      if (leaseRenewalTimer.current !== null) {
        globalThis.clearTimeout(leaseRenewalTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!draft.startsWith("/") || !canUseSlash || props.model.disabled) {
      return;
    }
    let cancelled = false;
    setSlashCatalog(null);
    setSlashError(null);
    props
      .onListCommands()
      .then((catalog) => {
        if (!cancelled) {
          setSlashCatalog(catalog);
          setSlashError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSlashCatalog(null);
          setSlashError(error instanceof Error ? error.message : String(error));
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [
    canUseSlash,
    draft,
    props.onListCommands,
    props.commandCatalogVersion,
    props.model.disabled,
  ]);

  const persistDraft = useCallback(
    (text: string, requestId?: string, requestText?: string): void => {
      writeSessionValue(composerDraftKey(props.draftScopeKey), {
        ...(requestId === undefined ? {} : { clientRequestId: requestId }),
        ...(requestText === undefined ? {} : { pendingText: requestText }),
        text,
      } satisfies StoredComposerDraft);
    },
    [props.draftScopeKey],
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
        writeSessionValue(composerLeaseKey(props.draftScopeKey), {
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
      props.draftScopeKey,
      queuedEdit,
    ],
  );

  useEffect(() => {
    const prefill = props.prefill;
    if (!prefill || prefill.nonce <= consumedPrefillNonce.current) return;
    consumedPrefillNonce.current = prefill.nonce;
    if (
      prefill.scopeKey !== props.draftScopeKey ||
      prefill.editRevision !== editRevision.current
    )
      return;
    updateDraft(prefill.text);
    setSlashDismissedDraft(null);
    setSlashError(null);
    setSlashIndex(0);
    textareaRef.current?.focus();
  }, [props.draftScopeKey, props.prefill, updateDraft]);

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
      20_000 - (Date.now() - lastLeaseRenewalAt.current),
    );
    leaseRenewalTimer.current = globalThis.setTimeout(() => {
      leaseRenewalTimer.current = null;
      void props.client
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
          writeSessionValue(composerLeaseKey(props.draftScopeKey), {
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
    draft,
    leaseActivityVersion,
    persistDraft,
    props.client,
    props.draftScopeKey,
    queuedEdit,
  ]);

  useEffect(() => {
    if (
      !queuedEdit ||
      queuedEdit.retainedSendText !== undefined ||
      queuedEdit.leaseLost ||
      isSubmitting
    )
      return;
    const prompt = props.queuedPrompts.find(
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
  }, [queuedEdit, props.queuedPrompts, isSubmitting]);

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
      void props.client
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
            void props.client
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
          writeSessionValue(composerLeaseKey(props.draftScopeKey), {
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
      draft,
      pendingRequestId,
      pendingText,
      props.client,
      props.draftScopeKey,
      queuedEdit,
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
    const input = {
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
          ? { retainedSendText: input.text }
          : {}),
      };
      queuedEditRef.current = next;
      setQueuedEdit(next);
      writeSessionValue(composerLeaseKey(props.draftScopeKey), {
        ...next,
        editText: draft,
        lastActivityAt: Date.now(),
      } satisfies StoredQueuedEdit);
    }
    const mutation =
      queuedEdit.status === "retained"
        ? props.client.resubmitRetainedPrompt({ ...input, operationId })
        : props.client.editQueuedPrompt(input);
    void mutation
      .then(() => {
        if (
          generation !== draftScopeGeneration.current ||
          queuedEditRef.current?.editLeaseId !== queuedEdit.editLeaseId
        )
          return;
        const restored = queuedEdit.originalDraft;
        setQueuedEdit(null);
        setDraft(restored);
        setPendingRequestId(queuedEdit.originalPendingRequestId ?? null);
        setPendingText(queuedEdit.originalPendingText ?? null);
        persistDraft(
          restored,
          queuedEdit.originalPendingRequestId,
          queuedEdit.originalPendingText,
        );
        removeSessionValue(composerLeaseKey(props.draftScopeKey));
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
    draft,
    isSubmitting,
    persistDraft,
    props.client,
    props.draftScopeKey,
    queuedEdit,
  ]);

  const releaseQueuedEdit = useCallback((): void => {
    if (!queuedEdit) return;
    const current = queuedEdit;
    void props.client
      .releasePromptEditLease({
        editLeaseId: current.editLeaseId,
        promptId: current.promptId,
      })
      .catch(() => undefined);
    setQueuedEdit(null);
    setDraft(current.originalDraft);
    setPendingRequestId(current.originalPendingRequestId ?? null);
    setPendingText(current.originalPendingText ?? null);
    persistDraft(
      current.originalDraft,
      current.originalPendingRequestId,
      current.originalPendingText,
    );
    removeSessionValue(composerLeaseKey(props.draftScopeKey));
  }, [persistDraft, props.client, props.draftScopeKey, queuedEdit]);

  const cancelQueuedPrompt = useCallback(
    (promptId: string): void => {
      const generation = draftScopeGeneration.current;
      const editLeaseId =
        queuedEdit?.promptId === promptId ? queuedEdit.editLeaseId : undefined;
      void props.client
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
            setQueuedEdit(null);
            setDraft(queuedEdit.originalDraft);
            setPendingRequestId(queuedEdit.originalPendingRequestId ?? null);
            setPendingText(queuedEdit.originalPendingText ?? null);
            persistDraft(
              queuedEdit.originalDraft,
              queuedEdit.originalPendingRequestId,
              queuedEdit.originalPendingText,
            );
            removeSessionValue(composerLeaseKey(props.draftScopeKey));
          }
        })
        .catch((error: unknown) => {
          if (generation !== draftScopeGeneration.current) return;
          setQueueError(error instanceof Error ? error.message : String(error));
        });
    },
    [persistDraft, props.client, props.draftScopeKey, queuedEdit],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (props.readOnly || !text || !canSend) {
      return;
    }
    if (queuedEdit) {
      finishQueuedEdit();
      return;
    }
    const generation = draftScopeGeneration.current;
    const revision = editRevision.current;
    const clientRequestId = pendingRequestId ?? globalThis.crypto.randomUUID();
    setPendingRequestId(clientRequestId);
    setPendingText(text);
    draftRef.current = "";
    setDraft("");
    persistDraft("", clientRequestId, text);
    void props
      .onSubmit(text, clientRequestId, selectedReasoning.current)
      .then((sent) => {
        if (generation !== draftScopeGeneration.current) {
          const key = composerDraftKey(props.draftScopeKey);
          const stored = readSessionValue(key) as StoredComposerDraft | null;
          if (stored?.clientRequestId === clientRequestId) {
            if (sent && !stored.text) removeSessionValue(key);
            else
              writeSessionValue(key, {
                text: stored.text || (sent ? "" : text),
              } satisfies StoredComposerDraft);
          }
          return;
        }
        setPendingRequestId(null);
        setPendingText(null);
        if (sent) {
          if (draftRef.current.length === 0) {
            removeSessionValue(composerDraftKey(props.draftScopeKey));
          } else {
            persistDraft(draftRef.current);
          }
          return;
        }
        const restored =
          editRevision.current === revision && draftRef.current.length === 0
            ? text
            : draftRef.current;
        draftRef.current = restored;
        setDraft(restored);
        persistDraft(restored);
      });
  }, [
    canSend,
    draft,
    finishQueuedEdit,
    pendingRequestId,
    persistDraft,
    props.draftScopeKey,
    props.onSubmit,
    queuedEdit,
  ]);

  const cycleMode = useCallback(() => {
    const mode = props.model.mode === "auto" ? "plan" : "auto";
    props.onSetPermission({ mode });
  }, [props.onSetPermission, props.model.mode]);

  const runSlashCommand = useCallback(
    (item: SlashPaletteItem | undefined) => {
      if (!canUseSlash) {
        return;
      }
      const commandText = item?.label ?? draft.trim();
      if (!commandText) {
        return;
      }
      if (item?.executionKind === "overlay") {
        props.onStructuredCommand({ item, text: draft.trim() || item.label });
        updateDraft("");
        setSlashDismissedDraft(null);
        setSlashError(null);
        return;
      }
      const generation = draftScopeGeneration.current;
      const revision = editRevision.current;
      setIsSubmitting(true);
      void props
        .onSubmit(commandText)
        .then((sent) => {
          if (
            sent &&
            generation === draftScopeGeneration.current &&
            revision === editRevision.current
          ) {
            updateDraft("");
            setSlashDismissedDraft(null);
          }
        })
        .finally(() => {
          if (generation === draftScopeGeneration.current)
            setIsSubmitting(false);
        });
    },
    [
      canUseSlash,
      draft,
      props.onStructuredCommand,
      props.onSubmit,
      updateDraft,
    ],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (isImeComposing(event)) {
        return;
      }
      if (slashOpen) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSlashIndex((index) => Math.min(index + 1, slashItems.length - 1));
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSlashIndex((index) => Math.max(index - 1, 0));
          return;
        }
        if (event.key === "PageDown") {
          event.preventDefault();
          setSlashIndex((index) => Math.min(index + 5, slashItems.length - 1));
          return;
        }
        if (event.key === "PageUp") {
          event.preventDefault();
          setSlashIndex((index) => Math.max(index - 5, 0));
          return;
        }
        if (event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          if (selectedCommand) {
            updateDraft(selectedCommand.label);
            setSlashDismissedDraft(null);
          }
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          runSlashCommand(selectedCommand);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setSlashDismissedDraft(draft);
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
        return;
      }
      if (event.key === "Escape" && queuedEdit) {
        event.preventDefault();
        releaseQueuedEdit();
        return;
      }
      if (event.key === "Tab" && event.shiftKey) {
        event.preventDefault();
        cycleMode();
        return;
      }
      if (event.key === "Escape" && props.model.canStop) {
        const now = Date.now();
        if (now - lastEscapeAt.current < 650) {
          props.onStop();
          lastEscapeAt.current = 0;
        } else {
          lastEscapeAt.current = now;
        }
      }
    },
    [
      cycleMode,
      draft,
      props.onStop,
      props.model.canStop,
      queuedEdit,
      releaseQueuedEdit,
      runSlashCommand,
      selectedCommand,
      send,
      slashItems.length,
      slashOpen,
      updateDraft,
    ],
  );

  return (
    <section
      className={`${props.compact ? "ohb-composer ohb-composer-hero" : "ohb-composer"}${props.readOnly ? " is-readonly" : ""}`}
    >
      <div
        className="ohb-composer-content"
        inert={props.readOnly}
        aria-hidden={props.readOnly ? true : undefined}
        onClickCapture={(event) => {
          if (props.readOnly) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onKeyDownCapture={(event) => {
          if (props.readOnly) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        {props.topContent}
        {props.unsentSteer ? (
          <p className="ohb-unsent-steer" role="status">
            Task stopped before your steer message was sent.
          </p>
        ) : null}
        {steerNoticeRunId && steerNoticeRunId === props.model.activeRunId ? (
          <p role="status">
            Steer accepted · waiting for the active run’s next safe boundary
          </p>
        ) : null}
        {props.queuedPrompts.length > 0 ? (
          <section className="ohb-prompt-queue" aria-label="Queued prompts">
            <div className="ohb-prompt-queue-header">
              <span>Queued {String(props.queuedPrompts.length)}</span>
              {props.queuedPrompts.length > 5 ? (
                <button
                  onClick={() => {
                    setQueueExpanded((expanded) => !expanded);
                  }}
                  title={
                    queueExpanded
                      ? "Collapse queued prompts"
                      : "Show all queued prompts"
                  }
                  type="button"
                >
                  {queueExpanded ? "Show less" : "Show all"}
                </button>
              ) : null}
            </div>
            <div className="ohb-prompt-queue-items">
              {visibleQueuedPrompts.map((prompt) => {
                const editing = queuedEdit?.promptId === prompt.promptId;
                return (
                  <div
                    className={`ohb-prompt-queue-item ${editing ? "is-editing" : ""}`}
                    key={prompt.promptId}
                  >
                    <span className="ohb-prompt-queue-text">
                      <span aria-hidden="true">↳ </span>
                      <span>{prompt.text}</span>
                      {prompt.status === "retained" ? (
                        <small> · Retained</small>
                      ) : null}
                      {editing ? <small> · editing</small> : null}
                    </span>
                    <SteerButton
                      prompt={prompt}
                      runId={props.model.activeRunId}
                      disabled={
                        isSubmitting ||
                        queueAcquirePending ||
                        editing ||
                        props.model.disabled
                      }
                      steer={(input) => props.client.steerQueuedPrompt(input)}
                      onAccepted={() => {
                        if (
                          currentSteerTarget.current.activeRunId ===
                            props.model.activeRunId &&
                          currentSteerTarget.current.activeSessionId ===
                            props.model.activeSessionId
                        )
                          setSteerNoticeRunId(props.model.activeRunId);
                      }}
                    />
                    <button
                      aria-label={`Edit prompt: ${prompt.text}`}
                      title="Edit prompt"
                      className="ohb-prompt-queue-edit"
                      disabled={isSubmitting || queueAcquirePending}
                      onClick={() => {
                        beginQueuedEdit(prompt);
                      }}
                      type="button"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      aria-label={`Delete prompt: ${prompt.text}`}
                      className="ohb-prompt-queue-cancel"
                      disabled={isSubmitting || queueAcquirePending}
                      onClick={() => {
                        cancelQueuedPrompt(prompt.promptId);
                      }}
                      title="Delete prompt"
                      type="button"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
        <div
          className={`ohb-composer-input${props.model.mode === "plan" ? " is-plan" : ""}`}
          ref={composerInputRef}
        >
          {slashOpen ? (
            <SlashPalette
              items={slashItems}
              onHover={setSlashIndex}
              onRun={(item) => {
                runSlashCommand(item);
              }}
              placement={props.compact ? "down" : "up"}
              selectedIndex={slashIndex}
            />
          ) : null}
          <div className="ohb-composer-text">
            <TypewriterPlaceholder
              active={showTypewriterPlaceholder}
              phrases={COMPOSER_PLACEHOLDER_PHRASES}
            />
            <textarea
              aria-label={`Message, ${props.model.mode} mode, ${props.model.permissionLevel} permission`}
              disabled={props.model.disabled || isSubmitting}
              readOnly={queuedEdit?.retainedSendText !== undefined}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                const nextDraft = event.target.value;
                updateDraft(nextDraft);
                setSlashIndex(0);
                if (nextDraft !== slashDismissedDraft) {
                  setSlashDismissedDraft(null);
                }
              }}
              onBlur={() => {
                setIsFocused(false);
              }}
              onFocus={() => {
                setIsFocused(true);
              }}
              onKeyDown={onKeyDown}
              placeholder={composerPlaceholder(
                props.connectionKind,
                props.model.isRunning,
              )}
              ref={textareaRef}
              rows={1}
              value={draft}
            />
          </div>
          {completionSuffix && selectedCommand ? (
            <span className="ohb-slash-completion" aria-hidden="true">
              <span>⇥ {selectedCommand.label}</span>
            </span>
          ) : null}
          {slashError || queueError || queuedEdit ? (
            <div className="ohb-composer-feedback">
              {slashError ? (
                <span className="ohb-slash-error">{slashError}</span>
              ) : null}
              {queueError ? (
                <span className="ohb-slash-error">{queueError}</span>
              ) : null}
              {queuedEdit ? (
                <span className="ohb-composer-hint ohb-queued-edit-hint">
                  {queuedEdit.retainedSendText !== undefined
                    ? "Retained send · Enter retry the same send"
                    : queuedEdit.status === "retained"
                      ? "Editing retained prompt · Enter send"
                      : "Editing queued prompt · Enter save"}{" "}
                  · Esc restore draft
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="ohb-composer-bar">
            {props.permissionControl}
            <div className="ohb-composer-bar-spacer" />
            <ReasoningControl
              client={props.client}
              session={props.activeSession}
              onChange={(reasoning) => {
                selectedReasoning.current = reasoning;
              }}
            />
            {showStop ? (
              <button
                aria-busy={props.stopLabel !== undefined}
                aria-label={props.stopLabel ?? "Stop run"}
                className="ohb-stop-button"
                disabled={props.stopLabel !== undefined || !props.model.canStop}
                onClick={props.onStop}
                title={props.stopLabel ?? "Stop run"}
                type="button"
              >
                {props.stopLabel ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="ohb-stop-pending"
                    size={14}
                  />
                ) : (
                  <Square size={14} />
                )}
              </button>
            ) : (
              <button
                aria-busy={props.isPromptAdmitting}
                aria-label={
                  queuedEdit
                    ? queuedEdit.retainedSendText !== undefined
                      ? "Retry retained send"
                      : queuedEdit.status === "retained"
                        ? "Send retained prompt"
                        : "Save queued prompt"
                    : "Send message"
                }
                className="ohb-send-button"
                disabled={!canSend}
                onClick={send}
                title={
                  queuedEdit
                    ? queuedEdit.retainedSendText !== undefined
                      ? "Retry retained send"
                      : queuedEdit.status === "retained"
                        ? "Send retained prompt"
                        : "Save queued prompt"
                    : "Send message"
                }
                type="button"
              >
                {props.isPromptAdmitting ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="ohb-send-spinner"
                    size={14}
                  />
                ) : (
                  <Send size={14} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
      {props.readOnly ? (
        <div className="ohb-composer-readonly-label">Read-only subagent</div>
      ) : null}
    </section>
  );
}

function composerPlaceholder(
  connectionKind: string,
  isRunning: boolean,
): string {
  if (
    ["connecting", "reconnecting", "resyncing", "disconnected"].includes(
      connectionKind,
    )
  ) {
    return "Draft while reconnecting…";
  }
  if (isRunning) {
    return "run in progress";
  }
  return "";
}
