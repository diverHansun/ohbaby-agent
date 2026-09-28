import { SteerButton } from "./SteerButton.js";
import { LoaderCircle, Send, Square, X } from "lucide-react";
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
    | "cancelQueuedPrompt"
    | "steerQueuedPrompt"
    | "getCurrentModel"
    | "subscribeEvents"
    | "updateSessionReasoning"
  >;
  readonly compact?: boolean;
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
  const [steerNotice, setSteerNotice] = useState(false);
  useEffect(() => {
    setSteerNotice(false);
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
  useLayoutEffect(() => {
    draftRef.current = draft;
    queuedEditRef.current = queuedEdit;
  }, [draft, queuedEdit]);
  const draftScopeGeneration = useRef(0);
  const editRevision = useRef(0);
  const consumedPrefillNonce = useRef(0);
  const advanceEditRevision = useCallback((): void => {
    editRevision.current += 1;
    props.onEditRevision(editRevision.current);
  }, [props.onEditRevision]);
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
    props.model.canSend && !isSubmitting && !props.isPromptAdmitting;
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
    setQueuedEdit(storedLease);
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
        removeSessionValue(composerLeaseKey(props.draftScopeKey));
        writeSessionValue(composerDraftKey(props.draftScopeKey), {
          text: draftRef.current,
        } satisfies StoredComposerDraft);
        setQueuedEdit(null);
        setQueueError(
          "Queued edit lease expired. Your text is preserved and can be sent as a new prompt.",
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
      advanceEditRevision();
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      const keepPending =
        pendingRequestId !== null && pendingText === nextDraft.trim();
      if (!keepPending) {
        setPendingRequestId(null);
        setPendingText(null);
      }
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
    if (!queuedEdit || leaseActivityVersion === 0) return;
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
          if (cancelled || generation !== draftScopeGeneration.current) return;
          lastLeaseRenewalAt.current = Date.now();
          writeSessionValue(composerLeaseKey(props.draftScopeKey), {
            ...queuedEdit,
            editText: draft,
            expiresAt: lease.expiresAt,
            lastActivityAt: Date.now(),
          } satisfies StoredQueuedEdit);
        })
        .catch(() => {
          if (cancelled || generation !== draftScopeGeneration.current) return;
          setQueuedEdit(null);
          removeSessionValue(composerLeaseKey(props.draftScopeKey));
          persistDraft(draft);
          setQueueError(
            "Queued edit lease expired. Your text is preserved and can be sent as a new prompt.",
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
          if (queueAcquireGenerationRef.current !== acquireGeneration) {
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
            originalDraft: draft,
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
          setDraft(prompt.text);
          setPendingRequestId(null);
          setPendingText(null);
          writeSessionValue(composerLeaseKey(props.draftScopeKey), {
            ...next,
            editText: prompt.text,
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
    if (!queuedEdit || !draft.trim()) return;
    const generation = draftScopeGeneration.current;
    setIsSubmitting(true);
    void props.client
      .editQueuedPrompt({
        editLeaseId: queuedEdit.editLeaseId,
        promptId: queuedEdit.promptId,
        text: draft.trim(),
      })
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
        setQueueError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (generation === draftScopeGeneration.current) setIsSubmitting(false);
      });
  }, [draft, persistDraft, props.client, props.draftScopeKey, queuedEdit]);

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
        {steerNotice ? (
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
                    <button
                      aria-label={`Edit queued prompt: ${prompt.text}`}
                      className="ohb-prompt-queue-edit"
                      disabled={isSubmitting || queueAcquirePending}
                      onClick={() => {
                        beginQueuedEdit(prompt);
                      }}
                      type="button"
                    >
                      <span aria-hidden="true">↳</span>
                      <span>{prompt.text.replaceAll("\n", " ")}</span>
                      {editing ? <small>editing</small> : null}
                    </button>
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
                        setSteerNotice(true);
                      }}
                    />
                    <button
                      aria-label={`Cancel queued prompt: ${prompt.text}`}
                      className="ohb-prompt-queue-cancel"
                      disabled={isSubmitting || queueAcquirePending}
                      onClick={() => {
                        cancelQueuedPrompt(prompt.promptId);
                      }}
                      title="Cancel queued prompt"
                      type="button"
                    >
                      <X size={13} />
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
                  Editing queued prompt · Enter save · Esc keep original
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
                aria-label={queuedEdit ? "Save queued prompt" : "Send message"}
                className="ohb-send-button"
                disabled={!canSend}
                onClick={send}
                title={queuedEdit ? "Save queued prompt" : "Send message"}
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
