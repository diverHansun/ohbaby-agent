import { randomUUID } from "node:crypto";
import { Box, Text, useInput, usePaste } from "ink";
import { formatError } from "../../format-error.js";
import type {
  CoreAPI,
  UiCurrentModelConfig,
  UiCommandInvocation,
  UiGoal,
  UiPermissionState,
  UiPromptSubmission,
  UiReasoningConfig,
} from "ohbaby-sdk";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  getSlashCompletion,
  getSlashCompletionCandidates,
  getSlashCompletionPageIndex,
} from "../../slash-commands/completions.js";
import {
  parseSlashInput,
  resolveCommand,
} from "../../slash-commands/runtime.js";
import { useTuiLayout } from "../../layout/context.js";
import type { TuiCommandCatalog } from "../../store/snapshot.js";
import { useTheme } from "../../theme/index.js";
import { Completion } from "./completion.js";
import { createInputStream } from "./input-stream.js";
import { editorViewport } from "./editor-viewport.js";
import { formatFooterRows, sameFooterModel } from "./footer.js";
import {
  applyEditorAction,
  createEditorState,
  editorText,
  type EditorAction,
  type EditorState,
} from "./editor-reducer.js";
import {
  displayPanelKindForCommandId,
  interactivePanelKindForCommandId,
  type CommandPanelKind,
} from "../dialog/command-panel-state.js";

type SubmitPrompt = (
  text: string,
  reasoning?: UiReasoningConfig,
  source?: {
    readonly sessionId: string | null;
    readonly creationGeneration: number;
  },
) => Promise<import("ohbaby-sdk").UiPromptReceipt>;
export interface PromptProps {
  readonly canSubmit?: boolean;
  readonly footerOnly?: boolean;
  readonly submissionContextGeneration?: number;
  readonly unsentSteer?: boolean;
  readonly onQueueModeChange?: (active: boolean) => void;
  readonly submitPrompt?: SubmitPrompt;
  readonly onLoadHistory?: () => void;
  readonly activeSessionId: string | null;
  readonly activeRunId?: string;
  readonly pendingReasoning?: PendingReasoningSelection | null;
  readonly catalog: TuiCommandCatalog | null;
  readonly client: CoreAPI;
  readonly contextWindowUsage?: string;
  readonly projectRoot?: string;
  readonly model?: UiCurrentModelConfig | null;
  readonly reasoning?: UiReasoningConfig | null;
  readonly disabled: boolean;
  readonly goalStatus?: UiGoal["status"];
  readonly isRuntimeRunning?: boolean;
  readonly loadCatalog?: () => Promise<TuiCommandCatalog>;
  readonly onCommandPanelOpen?: (input: {
    readonly invocation: UiCommandInvocation;
    readonly kind: CommandPanelKind;
  }) => void;
  readonly permission?: UiPermissionState;
  readonly queuedPrompts?: readonly UiPromptSubmission[];
  readonly runtimeStatusLabel?: string;
}

export interface PendingReasoningSelection {
  readonly reasoning: UiReasoningConfig;
  readonly model: UiCurrentModelConfig;
}

export function Prompt({
  activeSessionId,
  activeRunId,
  footerOnly = false,
  submissionContextGeneration,
  canSubmit = true,
  unsentSteer = false,
  onQueueModeChange,
  submitPrompt,
  onLoadHistory,
  pendingReasoning,
  catalog,
  client,
  contextWindowUsage = "",
  projectRoot,
  model,
  reasoning,
  disabled,
  goalStatus,
  loadCatalog,
  onCommandPanelOpen,
  permission,
  queuedPrompts = [],
  runtimeStatusLabel,
}: PromptProps): ReactElement {
  const [steerSelection, setSteerSelection] = useState(0);
  const [queueSelectionId, setQueueSelectionId] = useState<string | null>(null);
  const queueSelectionRef = useRef<string | null>(null);
  const selectQueue = (id: string | null): void => {
    queueSelectionRef.current = id;
    setQueueSelectionId(id);
  };
  const [steerNoticeRunId, setSteerNoticeRunId] = useState<string>();
  const currentSteerTarget = useRef(activeRunId);
  const steerNoticeRevision = useRef(0);
  useLayoutEffect(() => {
    currentSteerTarget.current = activeRunId;
    setSteerNoticeRunId(undefined);
  }, [activeSessionId, activeRunId]);
  const steerAttempts = useRef(
    new Map<string, import("ohbaby-sdk").UiSteerQueuedPromptInput>(),
  );
  useEffect(() => {
    steerAttempts.current.clear();
    setSteerNoticeRunId(undefined);
    setSteerSelection(0);
  }, [activeSessionId]);
  const theme = useTheme();
  const layout = useTuiLayout();
  const [editor, setEditor] = useState<EditorState>(() => createEditorState());
  const [error, setError] = useState<string | null>(null);
  const [queuedEdit, setQueuedEdit] = useState<{
    readonly editLeaseId: string;
    readonly status: "queued" | "retained";
    readonly operationId: string;
    /** Receipt recovery must replay the original request, including its text. */
    readonly retainedSendText?: string;
    readonly expiresAt: string;
    readonly leaseLost?: boolean;
    readonly originalEditor: EditorState;
    readonly promptId: string;
  } | null>(null);
  const [queuedMutationPending, setQueuedMutationPending] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const editorRef = useRef(editor);
  const queuedEditRef = useRef(queuedEdit);
  const draftSessionRef = useRef(activeSessionId);
  const draftGeneration = useRef(0);
  const originSessions = useRef(new Map<number, string | null>());
  const sourceGenerationRef = useRef(submissionContextGeneration);
  const inputStream = useRef(createInputStream());
  const insertionSequence = useRef<{
    base: EditorState;
    text: string;
    state: EditorState;
  } | null>(null);
  const inFlightEditLeases = useRef(new Set<string>());
  const [preparing, setPreparing] = useState(0);
  const preparingByGeneration = useRef(new Map<number, number>());
  const [unsent, setUnsent] = useState<readonly string[]>([]);
  const unsentRef = useRef<readonly string[]>([]);
  const replaceUnsent = (next: readonly string[]): void => {
    unsentRef.current = next;
    setUnsent(next);
  };
  const sessionDrafts = useRef(
    new Map<
      string | null,
      {
        editor: EditorState;
        edit: typeof queuedEdit;
        unsent?: readonly string[];
        error?: string | null;
      }
    >(),
  );
  const queuedMutationPendingRef = useRef(false);
  const lastLeaseRenewalAtRef = useRef(0);
  const selectedIndexRef = useRef(0);
  const pendingSubmissionRef = useRef<Promise<void>>(Promise.resolve());
  const acceptedNewSessionIdRef = useRef<string | null>(null);
  const previousSessionIdRef = useRef(activeSessionId);

  useEffect(() => {
    if (previousSessionIdRef.current !== null && activeSessionId === null) {
      acceptedNewSessionIdRef.current = null;
    }
    previousSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const replaceEditor = (nextEditor: EditorState): void => {
    if (editorText(editorRef.current) !== editorText(nextEditor)) {
      steerNoticeRevision.current += 1;
      setSteerNoticeRunId(undefined);
    }
    editorRef.current = nextEditor;
    setEditor(nextEditor);
  };

  const replaceInput = (nextInput: string): void => {
    replaceEditor(
      createEditorState({
        history: editorRef.current.history,
        text: nextInput,
      }),
    );
  };

  const applyEditor = (
    action: EditorAction,
  ): ReturnType<typeof applyEditorAction> => {
    let result: ReturnType<typeof applyEditorAction>;
    if (action.type === "insert") {
      const previous = insertionSequence.current;
      const base =
        previous?.state === editorRef.current
          ? previous.base
          : editorRef.current;
      const text =
        (previous?.state === editorRef.current ? previous.text : "") +
        action.text;
      result = applyEditorAction(base, { type: "insert", text });
      // Keep the raw insertion anchor while suffix fragments arrive. The
      // displayed cursor still always follows complete grapheme boundaries.
      insertionSequence.current = { base, text, state: result.state };
    } else {
      insertionSequence.current = null;
      result = applyEditorAction(editorRef.current, action);
    }
    replaceEditor(result.state);
    return result;
  };

  const selectIndex = (index: number): void => {
    selectedIndexRef.current = index;
    setSelectedIndex(index);
  };

  const replaceQueuedEdit = (next: typeof queuedEdit): void => {
    queuedEditRef.current = next;
    setQueuedEdit(next);
  };

  useLayoutEffect(() => {
    const explicitChange =
      submissionContextGeneration !== sourceGenerationRef.current;
    const receiptBinding =
      draftSessionRef.current === null &&
      activeSessionId !== null &&
      !explicitChange &&
      (submissionContextGeneration !== undefined ||
        activeSessionId === acceptedNewSessionIdRef.current);
    if (receiptBinding) {
      draftSessionRef.current = activeSessionId;
      acceptedNewSessionIdRef.current = activeSessionId;
      originSessions.current.set(draftGeneration.current, activeSessionId);
      return;
    }
    if (draftSessionRef.current === activeSessionId && !explicitChange) return;
    sessionDrafts.current.set(draftSessionRef.current, {
      editor: editorRef.current,
      edit: queuedEditRef.current,
      unsent,
      error,
    });
    draftGeneration.current += 1;
    sourceGenerationRef.current = submissionContextGeneration;
    acceptedNewSessionIdRef.current = null;
    inputStream.current.reset();
    setPreparing(0);
    replaceUnsent([]);
    draftSessionRef.current = activeSessionId;
    const stored = sessionDrafts.current.get(activeSessionId);
    replaceUnsent(
      activeSessionId === null
        ? (stored?.unsent ?? []).map((message) =>
            message.startsWith("Earlier new-session input not sent · ")
              ? message
              : `Earlier new-session input not sent · ${message}`,
          )
        : (stored?.unsent ?? []),
    );
    // A new creation context starts blank; earlier unbound intentions stay
    // available through the existing history keys, without implicit sending.
    replaceEditor(
      activeSessionId === null
        ? createEditorState({ history: stored?.editor.history ?? [] })
        : (stored?.editor ?? createEditorState()),
    );
    replaceQueuedEdit(activeSessionId === null ? null : (stored?.edit ?? null));
    selectQueue(null);
    replaceQueuedMutationPending(
      stored?.edit !== null &&
        stored?.edit !== undefined &&
        inFlightEditLeases.current.has(stored.edit.editLeaseId),
    );
    setError(stored?.error ?? null);
  }, [activeSessionId, submissionContextGeneration]);

  useEffect(() => {
    onQueueModeChange?.(queueSelectionId !== null || queuedEdit !== null);
  }, [onQueueModeChange, queueSelectionId, queuedEdit]);

  useEffect(() => {
    if (
      queueSelectionId &&
      !queuedPrompts.some((prompt) => prompt.promptId === queueSelectionId)
    )
      selectQueue(null);
    if (
      !queuedEdit ||
      queuedEdit.retainedSendText !== undefined ||
      queuedEdit.leaseLost ||
      queuedMutationPending
    )
      return;
    const prompt = queuedPrompts.find(
      (item) => item.promptId === queuedEdit.promptId,
    );
    const invalidate = (): void => {
      if (queuedEditRef.current?.editLeaseId !== queuedEdit.editLeaseId) return;
      replaceQueuedEdit({ ...queuedEditRef.current, leaseLost: true });
      setError(
        "This edit is no longer available. Edited text is preserved; Esc restores your draft.",
      );
    };
    if (prompt?.status !== queuedEdit.status) {
      invalidate();
      return;
    }
    const delay = Date.parse(queuedEdit.expiresAt) - Date.now();
    if (delay <= 0) {
      invalidate();
      return;
    }
    const timer = setTimeout(
      () => {
        if (Date.now() >= Date.parse(queuedEdit.expiresAt)) invalidate();
      },
      Math.min(delay, 2_147_483_647),
    );
    return (): void => {
      clearTimeout(timer);
    };
  }, [queuedEdit, queuedPrompts, queueSelectionId, queuedMutationPending]);

  const replaceQueuedMutationPending = (next: boolean): void => {
    queuedMutationPendingRef.current = next;
    setQueuedMutationPending(next);
  };

  const restoreQueuedEditInput = (): void => {
    const current = queuedEditRef.current;
    if (!current) return;
    replaceEditor(current.originalEditor);
    replaceQueuedEdit(null);
    setError(null);
  };

  const renewQueuedEditLease = (): void => {
    const current = queuedEditRef.current;
    if (!current || current.retainedSendText !== undefined || current.leaseLost)
      return;
    const generation = draftGeneration.current;
    const now = Date.now();
    if (now - lastLeaseRenewalAtRef.current < 20_000) return;
    lastLeaseRenewalAtRef.current = now;
    void client
      .renewPromptEditLease({
        editLeaseId: current.editLeaseId,
        promptId: current.promptId,
      })
      .then((lease) => {
        if (
          generation !== draftGeneration.current ||
          queuedEditRef.current?.editLeaseId !== current.editLeaseId ||
          queuedEditRef.current.retainedSendText !== undefined
        )
          return;
        replaceQueuedEdit({
          ...queuedEditRef.current,
          expiresAt: lease.expiresAt,
          leaseLost:
            queuedEditRef.current.leaseLost === true ||
            Date.parse(lease.expiresAt) <= Date.now(),
        });
      })
      .catch((caught: unknown) => {
        if (
          generation !== draftGeneration.current ||
          queuedEditRef.current?.editLeaseId !== current.editLeaseId ||
          queuedEditRef.current.retainedSendText !== undefined
        )
          return;
        replaceQueuedEdit({ ...queuedEditRef.current, leaseLost: true });
        setError(
          `${formatError(caught)}. Edited text is preserved; Esc restores your draft.`,
        );
      });
  };

  usePaste(
    (text) => {
      const edit = queuedEditRef.current;
      if (
        queuedMutationPendingRef.current ||
        queueSelectionRef.current !== null ||
        edit?.retainedSendText !== undefined
      )
        return;
      if (edit) renewQueuedEditLease();
      applyEditor({ type: "insert", text: inputStream.current.push(text) });
      selectIndex(0);
      setError(null);
    },
    { isActive: !disabled && !footerOnly },
  );

  useInput(
    (value, key) => {
      // Reserved for the Tasks viewport; plain PageUp still loads history.
      if (key.meta && (key.pageUp || key.pageDown)) return;
      if (queuedMutationPendingRef.current) return;
      if (value.startsWith("\n") && inputStream.current.pendingCR()) {
        const continuation = inputStream.current.push(value);
        if (continuation) applyEditor({ type: "insert", text: continuation });
        return;
      }
      const generation = draftGeneration.current;
      if (key.ctrl && (key.upArrow || key.downArrow)) {
        setSteerSelection((current) =>
          Math.max(
            0,
            Math.min(
              queuedPrompts.length - 1,
              current + (key.downArrow ? 1 : -1),
            ),
          ),
        );
        return;
      }
      if (key.ctrl && (value === "s" || value === "\x13")) {
        const prompt = queueSelectionRef.current
          ? queuedPrompts.find(
              (item) => item.promptId === queueSelectionRef.current,
            )
          : queuedPrompts.at(
              Math.min(steerSelection, queuedPrompts.length - 1),
            );
        if (
          !prompt ||
          !activeRunId ||
          prompt.status !== "queued" ||
          prompt.editLeaseOwnerId ||
          queuedEditRef.current
        )
          return;
        const previous = steerAttempts.current.get(prompt.promptId);
        if (previous && previous.expectedRunId !== activeRunId) {
          setError(
            "The original Steer target ended; the queued prompt was retained",
          );
          return;
        }
        const input = previous ?? {
          promptId: prompt.promptId,
          expectedRunId: activeRunId,
          clientRequestId: randomUUID(),
        };
        steerAttempts.current.set(prompt.promptId, input);
        replaceQueuedMutationPending(true);
        setError(null);
        const noticeRevision = steerNoticeRevision.current;
        void client
          .steerQueuedPrompt(input)
          .then(
            () => {
              if (
                generation !== draftGeneration.current ||
                currentSteerTarget.current !== input.expectedRunId ||
                noticeRevision !== steerNoticeRevision.current
              )
                return;
              setSteerNoticeRunId(input.expectedRunId);
            },
            (caught: unknown) => {
              if (generation !== draftGeneration.current) return;
              setError(
                `${formatError(caught)} · retry keeps the original target`,
              );
            },
          )
          .finally(() => {
            if (generation === draftGeneration.current)
              replaceQueuedMutationPending(false);
          });
        return;
      }
      const currentInput = editorText(editorRef.current);
      const candidates = getSlashCompletionCandidates(currentInput, catalog);

      if (key.meta && key.upArrow) {
        if (queuedEditRef.current) return;
        selectQueue(queuedPrompts.at(-1)?.promptId ?? null);
        return;
      }

      const selectedPromptId = queueSelectionRef.current;
      if (selectedPromptId !== null) {
        const index = queuedPrompts.findIndex(
          (prompt) => prompt.promptId === selectedPromptId,
        );
        const prompt = queuedPrompts.find(
          (item) => item.promptId === selectedPromptId,
        );
        if (key.escape) {
          selectQueue(null);
          return;
        }
        if (!prompt) {
          selectQueue(null);
          return;
        }
        if (key.upArrow || key.downArrow) {
          selectQueue(
            queuedPrompts[
              Math.max(
                0,
                Math.min(
                  queuedPrompts.length - 1,
                  index + (key.downArrow ? 1 : -1),
                ),
              )
            ]?.promptId ?? null,
          );
          return;
        }
        if (key.ctrl && (value === "d" || value === "\x04")) {
          replaceQueuedMutationPending(true);
          void client
            .cancelQueuedPrompt({ promptId: prompt.promptId })
            .then(() => {
              if (generation !== draftGeneration.current) return;
              selectQueue(null);
              setError(null);
            })
            .catch((caught: unknown) => {
              if (generation === draftGeneration.current)
                setError(formatError(caught));
            })
            .finally(() => {
              if (generation === draftGeneration.current)
                replaceQueuedMutationPending(false);
            });
          return;
        }
        if (key.return) {
          setError(null);
          replaceQueuedMutationPending(true);
          void client
            .acquirePromptEditLease({ promptId: prompt.promptId })
            .then((lease) => {
              if (
                generation !== draftGeneration.current ||
                queueSelectionRef.current !== prompt.promptId
              ) {
                void client
                  .releasePromptEditLease({
                    promptId: prompt.promptId,
                    editLeaseId: lease.editLeaseId,
                  })
                  .catch(() => undefined);
                return;
              }
              replaceQueuedEdit({
                editLeaseId: lease.editLeaseId,
                expiresAt: lease.expiresAt,
                status:
                  lease.prompt.status === "retained" ? "retained" : "queued",
                operationId: randomUUID(),
                originalEditor: editorRef.current,
                promptId: prompt.promptId,
              });
              selectQueue(null);
              lastLeaseRenewalAtRef.current = Date.now();
              replaceInput(lease.prompt.text);
            })
            .catch((caught: unknown) => {
              if (generation === draftGeneration.current)
                setError(formatError(caught));
            })
            .finally(() => {
              if (generation === draftGeneration.current)
                replaceQueuedMutationPending(false);
            });
          return;
        }
        return;
      }

      const currentQueuedEdit = queuedEditRef.current;
      if (currentQueuedEdit && key.escape) {
        void client
          .releasePromptEditLease({
            editLeaseId: currentQueuedEdit.editLeaseId,
            promptId: currentQueuedEdit.promptId,
          })
          .catch(() => undefined);
        restoreQueuedEditInput();
        return;
      }

      if (key.return) {
        inputStream.current.reset();
        if (key.shift) {
          if (currentQueuedEdit?.retainedSendText !== undefined) return;
          if (currentQueuedEdit) renewQueuedEditLease();
          applyEditor({ type: "newline" });
          return;
        }

        if (!canSubmit && !currentInput.trim().startsWith("/")) {
          setError("Session is syncing; draft kept. Ctrl+R retries recovery.");
          return;
        }
        if (currentQueuedEdit) {
          if (
            currentInput.trim() === "" ||
            ((currentQueuedEdit.leaseLost ||
              Date.parse(currentQueuedEdit.expiresAt) <= Date.now()) &&
              currentQueuedEdit.retainedSendText === undefined)
          )
            return;
          replaceQueuedMutationPending(true);
          setError(null);
          const input = {
            editLeaseId: currentQueuedEdit.editLeaseId,
            promptId: currentQueuedEdit.promptId,
            text: currentQueuedEdit.retainedSendText ?? currentInput.trim(),
          };
          if (
            currentQueuedEdit.status === "retained" &&
            currentQueuedEdit.retainedSendText === undefined
          )
            replaceQueuedEdit({
              ...currentQueuedEdit,
              retainedSendText: input.text,
            });
          const mutationSourceSession = draftSessionRef.current;
          inFlightEditLeases.current.add(currentQueuedEdit.editLeaseId);
          const ownsLease = (): boolean =>
            draftSessionRef.current === mutationSourceSession &&
            queuedEditRef.current?.editLeaseId ===
              currentQueuedEdit.editLeaseId;
          const mutation =
            currentQueuedEdit.status === "retained"
              ? client.resubmitRetainedPrompt({
                  ...input,
                  operationId: currentQueuedEdit.operationId,
                })
              : client.editQueuedPrompt(input);
          void mutation
            .then(() => {
              if (ownsLease()) {
                replaceQueuedMutationPending(false);
                restoreQueuedEditInput();
              } else {
                const stored = sessionDrafts.current.get(mutationSourceSession);
                if (stored?.edit?.editLeaseId === currentQueuedEdit.editLeaseId)
                  sessionDrafts.current.set(mutationSourceSession, {
                    ...stored,
                    editor: stored.edit.originalEditor,
                    edit: null,
                    error: null,
                  });
              }
            })
            .catch((caught: unknown) => {
              const message =
                currentQueuedEdit.status === "retained"
                  ? `Send outcome unknown. Retry the original send. ${formatError(caught)}. Esc restores your draft.`
                  : formatError(caught);
              if (ownsLease()) setError(message);
              else {
                const stored = sessionDrafts.current.get(mutationSourceSession);
                if (stored?.edit?.editLeaseId === currentQueuedEdit.editLeaseId)
                  sessionDrafts.current.set(mutationSourceSession, {
                    ...stored,
                    error: message,
                  });
              }
            })
            .finally(() => {
              inFlightEditLeases.current.delete(currentQueuedEdit.editLeaseId);
              if (ownsLease()) replaceQueuedMutationPending(false);
            });
          return;
        }

        const result = applyEditor({ type: "submit" });
        if (result.submission === undefined) {
          return;
        }
        const submission = result.submission;
        const sourceSession = draftSessionRef.current;
        const sourceGeneration = draftGeneration.current;
        const creationGeneration =
          submissionContextGeneration ?? sourceGeneration;
        const sourceKey = sourceSession;
        if (!originSessions.current.has(sourceGeneration))
          originSessions.current.set(sourceGeneration, sourceSession);
        const selection = selectedIndexRef.current;
        const capturedReasoning =
          sourceSession === null ? pendingReasoning : null;
        const ownsContext = (): boolean =>
          sourceGeneration === draftGeneration.current;
        const notice = (message: string | null): void => {
          if (ownsContext()) setError(message);
        };
        const preserveUnsent = (message: string): void => {
          const storageKey =
            originSessions.current.get(sourceGeneration) ?? sourceKey;
          const currentOwner =
            ownsContext() ||
            (storageKey !== null && storageKey === draftSessionRef.current);
          const stored = sessionDrafts.current.get(storageKey);
          const reason = message
            .replace(/^Not sent: /u, "")
            .replace(/\.? ↑ recover text\.?$/u, "");
          const record = `Not sent · ↑ recover · ${reason} · ${submission.replace(/\s+/gu, " ").slice(0, 12)}`;
          const records = [
            ...(currentOwner ? unsentRef.current : (stored?.unsent ?? [])),
            record,
          ];
          if (currentOwner) replaceUnsent(records);
          else {
            if (stored)
              sessionDrafts.current.set(storageKey, {
                ...stored,
                unsent: records,
              });
            if (storageKey === null && draftSessionRef.current === null) {
              replaceUnsent([
                ...unsentRef.current,
                `Earlier new-session input not sent · ${reason}`,
              ]);
            }
          }
        };
        const prepareCount = (delta: number): void => {
          const count =
            (preparingByGeneration.current.get(sourceGeneration) ?? 0) + delta;
          preparingByGeneration.current.set(sourceGeneration, count);
          if (ownsContext()) setPreparing(count);
        };
        prepareCount(1);
        const send = async (): Promise<void> => {
          if (!ownsContext()) {
            preserveUnsent("Not sent: source context changed. ↑ recover text.");
            prepareCount(-1);
            return;
          }
          await submitInput(
            submission,
            sourceSession ?? acceptedNewSessionIdRef.current,
            capturedReasoning,
            catalog,
            client,
            loadCatalog,
            () => undefined,
            notice,
            selection,
            onCommandPanelOpen,
            true,
            (sessionId) => {
              if (ownsContext() && sourceSession === null)
                acceptedNewSessionIdRef.current = sessionId;
            },
            submitPrompt,
            ownsContext,
            preserveUnsent,
            { sessionId: sourceSession, creationGeneration },
          );
          prepareCount(-1);
        };
        // Preserve the existing first-send sequence for all independent intents
        // in one creation context; the editor remains available during prepare.
        if (sourceSession === null && !submission.trim().startsWith("/")) {
          pendingSubmissionRef.current = pendingSubmissionRef.current.then(
            send,
            send,
          );
        } else void send();
        return;
      }

      if (currentQueuedEdit?.retainedSendText !== undefined) {
        const navigation = key.leftArrow
          ? "move-left"
          : key.rightArrow
            ? "move-right"
            : key.home
              ? "move-home"
              : key.end
                ? "move-end"
                : null;
        if (navigation) applyEditor({ type: navigation });
        return;
      }
      if (currentQueuedEdit) renewQueuedEditLease();

      if (currentInput.startsWith("/") && candidates.length > 0) {
        if (key.upArrow) {
          selectIndex(
            (selectedIndexRef.current - 1 + candidates.length) %
              candidates.length,
          );
          return;
        }

        if (key.downArrow) {
          selectIndex((selectedIndexRef.current + 1) % candidates.length);
          return;
        }

        if (key.pageUp) {
          selectIndex(
            getSlashCompletionPageIndex(
              candidates.length,
              selectedIndexRef.current,
              "previous",
            ),
          );
          return;
        }

        if (key.pageDown) {
          selectIndex(
            getSlashCompletionPageIndex(
              candidates.length,
              selectedIndexRef.current,
              "next",
            ),
          );
          return;
        }
      }

      if (key.pageUp) {
        onLoadHistory?.();
        return;
      }

      if (key.upArrow) {
        applyEditor({ type: "history-up" });
        return;
      }

      if (key.downArrow) {
        applyEditor({ type: "history-down" });
        return;
      }

      if (key.tab && !key.shift) {
        replaceInput(
          getSlashCompletion(currentInput, catalog, selectedIndexRef.current),
        );
        selectIndex(0);
        return;
      }

      if (value === "\u0015" || (key.ctrl && value === "u")) {
        applyEditor({ type: "clear-line" });
        selectIndex(0);
        setError(null);
        return;
      }

      if (isDeleteControlInput(value, key)) {
        applyEditor({ type: "backspace" });
        selectIndex(0);
        return;
      }

      if (key.leftArrow) {
        applyEditor({ type: "move-left" });
        return;
      }

      if (key.rightArrow) {
        applyEditor({ type: "move-right" });
        return;
      }

      if (key.home) {
        applyEditor({ type: "move-home" });
        return;
      }

      if (key.end) {
        applyEditor({ type: "move-end" });
        return;
      }

      if (value.length > 0 && !key.ctrl && !key.meta) {
        applyEditor({ text: inputStream.current.push(value), type: "insert" });
        selectIndex(0);
        setError(null);
      }
    },
    { isActive: !disabled && !footerOnly },
  );

  const footerRows = formatFooterRows({
    width: layout.contentWidth,
    projectRoot,
    model,
    reasoning:
      !activeSessionId &&
      pendingReasoning &&
      sameFooterModel(model, pendingReasoning.model)
        ? pendingReasoning.reasoning
        : reasoning,
    permission,
    usage: contextWindowUsage,
  });
  const goalStatusColor =
    goalStatus === "active" ? theme.status.accent : theme.status.warning;

  return (
    <Box flexDirection="column" width={layout.contentWidth}>
      {footerOnly ? null : (
        <>
          {preparing > 0 ? <Text dimColor>Preparing…</Text> : null}
          {unsent.length > 0 ? (
            <Text dimColor wrap="truncate-end">
              {unsent.length > 1 ? `${String(unsent.length)} unsent · ` : ""}
              {unsent.at(-1)}
            </Text>
          ) : null}
          {unsentSteer ? (
            <Text dimColor>
              Task stopped before your steer message was sent.
            </Text>
          ) : null}
          {steerNoticeRunId && steerNoticeRunId === activeRunId ? (
            <Text>
              Steer accepted · waiting for the active run’s next safe boundary
            </Text>
          ) : null}
          {queuedPrompts.length === 0 ? null : (
            <Box
              flexDirection="column"
              paddingX={1}
              width={layout.contentWidth}
            >
              <Text dimColor>Queued {queuedPrompts.length}</Text>
              {queuedPrompts.map((prompt, index) => (
                <Text
                  dimColor={queuedEdit?.promptId !== prompt.promptId}
                  key={prompt.promptId}
                  wrap="truncate-end"
                >
                  {(
                    queueSelectionId
                      ? prompt.promptId === queueSelectionId
                      : index ===
                        Math.min(steerSelection, queuedPrompts.length - 1)
                  )
                    ? "›"
                    : "↳"}{" "}
                  {prompt.text.replace(/\s+/gu, " ").trim()}
                  {queuedEdit?.promptId === prompt.promptId ? " · editing" : ""}
                  {prompt.status === "retained" ? " · Retained" : ""}
                  {prompt.status === "queued" &&
                  activeRunId &&
                  !prompt.editLeaseOwnerId &&
                  !queuedEdit
                    ? " · Steer"
                    : " · Steer unavailable"}
                </Text>
              ))}
              <Text dimColor>
                {queueSelectionId
                  ? "↑/↓ select · Enter edit · Ctrl+D Delete · Esc back to draft"
                  : "Alt+↑ select queue · Ctrl+↑/↓ select Steer · Ctrl+S Steer"}
              </Text>
            </Box>
          )}
          {goalStatus === undefined ? null : (
            <Text color={goalStatusColor}>goal {goalStatus}</Text>
          )}
          {runtimeStatusLabel ? (
            <Text dimColor>{runtimeStatusLabel}</Text>
          ) : null}
          <Box
            borderColor={theme.border}
            borderStyle="single"
            borderLeft={false}
            borderRight={false}
            flexDirection="column"
            paddingX={1}
            width={layout.contentWidth}
          >
            {renderEditorLines(
              editor,
              disabled,
              theme.cursor,
              Math.max(0, layout.contentWidth - 4),
              Math.max(
                1,
                Math.min(disabled ? 3 : 5, Math.floor((layout.rows - 1) / 4)),
              ),
            )}
          </Box>
          {queuedEdit ? (
            <Text dimColor>
              {queuedMutationPending
                ? "Updating queued prompt…"
                : queuedEdit.retainedSendText !== undefined
                  ? "Enter retry the same send · Esc restore draft"
                  : queuedEdit.leaseLost
                    ? "Edit unavailable · Esc restore draft"
                    : queuedEdit.status === "retained"
                      ? "Enter send · Esc restore draft"
                      : "Enter save · Esc restore draft"}
            </Text>
          ) : null}
        </>
      )}
      <Box flexDirection="column" width={layout.contentWidth}>
        {footerRows.map((row, index) => (
          <Text key={index} dimColor wrap="truncate-end">
            {row}
          </Text>
        ))}
      </Box>
      {footerOnly || error === null ? null : (
        <Text color={theme.status.error}>{error}</Text>
      )}
      {footerOnly ? null : (
        <Completion
          catalog={catalog}
          input={editorText(editor)}
          selectedIndex={selectedIndex}
        />
      )}
    </Box>
  );
}

function renderEditorLines(
  editor: EditorState,
  disabled: boolean,
  cursorColor: string,
  width: number,
  maxRows: number,
): readonly ReactElement[] {
  if (disabled && editorText(editor).length === 0)
    return [
      <Text key="paused" dimColor>
        {"> paused"}
      </Text>,
    ];
  const initial = editorViewport(editor, width, maxRows);
  const range = initial[0]?.visibleRange;
  const rows =
    range && maxRows > 1 ? editorViewport(editor, width, maxRows - 1) : initial;
  const result = rows.map((row, index) => (
    <Text key={index} wrap="truncate-end">
      <Text dimColor={disabled || row.hiddenBefore}>
        {index === 0 ? (row.hiddenBefore ? "↑ " : "> ") : "  "}
      </Text>
      {disabled || row.cursorStart === undefined ? (
        row.text
      ) : (
        <>
          {row.text.slice(0, row.cursorStart)}
          <Text color={cursorColor} inverse>
            {row.text.slice(row.cursorStart, row.cursorEnd)}
          </Text>
          {row.text.slice(row.cursorEnd)}
        </>
      )}
    </Text>
  ));
  if (range && maxRows > 1) {
    const visible = rows[0]?.visibleRange ?? range;
    result.push(
      <Text
        key="range"
        dimColor
        wrap="truncate-end"
      >{`  lines ${String(visible.start)}–${String(visible.end)}/${String(visible.total)}`}</Text>,
    );
  } else if (rows.some((row) => row.resizeRequired) && maxRows > rows.length) {
    result.push(
      <Text key="resize" dimColor wrap="truncate-end">
        Resize terminal to read input
      </Text>,
    );
  }
  return result;
}

function isDeleteControlInput(
  value: string,
  key: { readonly backspace: boolean; readonly delete: boolean },
): boolean {
  return (
    key.backspace ||
    key.delete ||
    value === "\b" ||
    value === "\x7f" ||
    value === "[P" ||
    value === "\u001B[P"
  );
}

async function submitInput(
  input: string,
  activeSessionId: string | null,
  pendingReasoning: PendingReasoningSelection | null | undefined,
  catalog: TuiCommandCatalog | null,
  client: CoreAPI,
  loadCatalog: (() => Promise<TuiCommandCatalog>) | undefined,
  replaceInput: (nextInput: string) => void,
  setError: (message: string | null) => void,
  selectedIndex: number,
  onCommandPanelOpen:
    | ((input: {
        readonly invocation: UiCommandInvocation;
        readonly kind: CommandPanelKind;
      }) => void)
    | undefined,
  alreadyCleared = false,
  onAccepted?: (sessionId: string) => void,
  submitPrompt?: SubmitPrompt,
  ownsContext: () => boolean = () => true,
  preserveUnsent: (message: string) => void = () => undefined,
  source?: {
    readonly sessionId: string | null;
    readonly creationGeneration: number;
  },
): Promise<void> {
  const text = input.trim();

  if (text.trim() === "") {
    return;
  }

  if (!text.trim().startsWith("/")) {
    setError(null);
    if (!alreadyCleared) replaceInput("");
    let reasoning: UiReasoningConfig | undefined;
    if (pendingReasoning) {
      try {
        const current = await client.getCurrentModel();
        const original = pendingReasoning.model;
        const choice = pendingReasoning.reasoning;
        const capability = current?.reasoning;
        if (
          current?.provider === original.provider &&
          current.baseUrl === original.baseUrl &&
          current.interfaceProvider === original.interfaceProvider &&
          current.model === original.model &&
          capability?.status === "identified" &&
          (choice.enabled === false
            ? capability.supportsDisabled === true
            : capability.mode === "binary"
              ? choice.effort === undefined
              : capability.mode === "effort" &&
                choice.effort !== undefined &&
                capability.efforts.includes(choice.effort))
        ) {
          reasoning = choice;
        }
      } catch {
        // Model lookup must not prevent an otherwise valid first prompt.
      }
    }
    if (!ownsContext()) {
      preserveUnsent("Not sent: source context changed. ↑ recover text.");
      return;
    }
    try {
      const receipt = await (submitPrompt
        ? submitPrompt(text, reasoning, source)
        : client.submitPromptAccepted(text, {
            clientRequestId: randomUUID(),
            reasoning,
            sessionId: activeSessionId ?? undefined,
          }));
      onAccepted?.(receipt.sessionId);
    } catch (caught) {
      const message = formatError(caught);
      if (!message.startsWith("Submission outcome unknown"))
        preserveUnsent(`Not sent: ${message}. ↑ recover text.`);
      setError(message);
    }
    return;
  }

  let commandCatalog = catalog;
  if (commandCatalog === null) {
    if (!loadCatalog) {
      preserveUnsent(
        "Not sent: command catalog is not loaded. ↑ recover text.",
      );
      setError("Command catalog is not loaded");
      return;
    }
    setError(null);
    replaceInput("");
    try {
      commandCatalog = await loadCatalog();
    } catch (caught) {
      setError(formatError(caught));
      return;
    }
  }

  if (!ownsContext()) {
    preserveUnsent("Not sent: source context changed. ↑ recover text.");
    return;
  }
  const result = resolveCommand(parseSlashInput(text.trim()), commandCatalog, {
    sessionId: activeSessionId ?? undefined,
    surface: "tui",
  });
  const candidates = getSlashCompletionCandidates(text, commandCatalog);
  const selected =
    candidates.length > 0
      ? candidates[selectedIndex % candidates.length]
      : null;
  const selectedOverridesExact =
    result.kind === "resolved" &&
    selectedIndex > 0 &&
    selected !== null &&
    selected.id !== result.command.id;

  if ((result.kind !== "resolved" || selectedOverridesExact) && selected) {
    const selectedResult = resolveCommand(
      parseSlashInput(`/${selected.path.join(" ")}`),
      commandCatalog,
      {
        sessionId: activeSessionId ?? undefined,
        surface: "tui",
      },
    );
    if (selectedResult.kind === "resolved") {
      setError(null);
      replaceInput("");
      executeCommandInvocation(
        selectedResult.invocation,
        client,
        setError,
        onCommandPanelOpen,
      );
      return;
    }
  }

  if (result.kind !== "resolved") {
    preserveUnsent(`Not sent: ${result.reason}. ↑ recover text.`);
    setError(result.reason);
    return;
  }

  setError(null);
  replaceInput("");
  executeCommandInvocation(
    result.invocation,
    client,
    setError,
    onCommandPanelOpen,
  );
}

function executeCommandInvocation(
  invocation: UiCommandInvocation,
  client: CoreAPI,
  setError: (message: string | null) => void,
  onCommandPanelOpen:
    | ((input: {
        readonly invocation: UiCommandInvocation;
        readonly kind: CommandPanelKind;
      }) => void)
    | undefined,
): void {
  const interactiveKind = interactivePanelKindForCommandId(
    invocation.commandId,
  );
  if (interactiveKind !== null) {
    onCommandPanelOpen?.({ invocation, kind: interactiveKind });
    return;
  }

  const displayKind = displayPanelKindForCommandId(invocation.commandId);
  if (displayKind !== null) {
    onCommandPanelOpen?.({ invocation, kind: displayKind });
  }

  void client.executeCommand(invocation).catch((caught: unknown) => {
    setError(formatError(caught));
  });
}
