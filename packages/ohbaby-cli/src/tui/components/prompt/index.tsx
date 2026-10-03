import { randomUUID } from "node:crypto";
import { Box, Text, useInput } from "ink";
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
) => Promise<import("ohbaby-sdk").UiPromptReceipt>;
export interface PromptProps {
  readonly canSubmit?: boolean;
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
    readonly originalInput: string;
    readonly promptId: string;
  } | null>(null);
  const [queuedMutationPending, setQueuedMutationPending] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const editorRef = useRef(editor);
  const queuedEditRef = useRef(queuedEdit);
  const draftSessionRef = useRef(activeSessionId);
  const draftGeneration = useRef(0);
  const sessionDrafts = useRef(
    new Map<string | null, { editor: EditorState; edit: typeof queuedEdit }>(),
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
    const result = applyEditorAction(editorRef.current, action);
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
    if (draftSessionRef.current === activeSessionId) return;
    sessionDrafts.current.set(draftSessionRef.current, {
      editor: editorRef.current,
      edit: queuedEditRef.current,
    });
    draftGeneration.current += 1;
    draftSessionRef.current = activeSessionId;
    const stored = sessionDrafts.current.get(activeSessionId);
    replaceEditor(stored?.editor ?? createEditorState());
    replaceQueuedEdit(stored?.edit ?? null);
    selectQueue(null);
    replaceQueuedMutationPending(false);
    setError(null);
  }, [activeSessionId]);

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
    replaceInput(current.originalInput);
    replaceQueuedEdit(null);
    setError(null);
  };

  const renewQueuedEditLease = (): void => {
    const current = queuedEditRef.current;
    if (!current || current.retainedSendText !== undefined) return;
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
          leaseLost: false,
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

  useInput(
    (value, key) => {
      // Reserved for the Tasks viewport; plain PageUp still loads history.
      if (key.meta && (key.pageUp || key.pageDown)) return;
      if (queuedMutationPendingRef.current) return;
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
                originalInput: editorText(editorRef.current),
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
            (currentQueuedEdit.leaseLost &&
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
          const mutation =
            currentQueuedEdit.status === "retained"
              ? client.resubmitRetainedPrompt({
                  ...input,
                  operationId: currentQueuedEdit.operationId,
                })
              : client.editQueuedPrompt(input);
          void mutation
            .then(() => {
              if (
                generation === draftGeneration.current &&
                queuedEditRef.current?.editLeaseId ===
                  currentQueuedEdit.editLeaseId
              )
                restoreQueuedEditInput();
            })
            .catch((caught: unknown) => {
              if (generation === draftGeneration.current)
                setError(
                  currentQueuedEdit.status === "retained"
                    ? `Send outcome unknown. Retry the same send to recover its receipt. ${formatError(caught)}. Esc restores your draft.`
                    : formatError(caught),
                );
            })
            .finally(() => {
              if (generation === draftGeneration.current)
                replaceQueuedMutationPending(false);
            });
          return;
        }

        const result = applyEditor({ type: "submit" });
        if (result.submission === undefined) {
          return;
        }
        if (
          activeSessionId === null &&
          pendingReasoning !== null &&
          pendingReasoning !== undefined &&
          !result.submission.trim().startsWith("/")
        ) {
          const submission = result.submission;
          replaceInput("");
          const send = (): Promise<void> =>
            submitInput(
              submission,
              acceptedNewSessionIdRef.current,
              pendingReasoning,
              catalog,
              client,
              loadCatalog,
              replaceInput,
              setError,
              selectedIndexRef.current,
              onCommandPanelOpen,
              true,
              (sessionId) => {
                acceptedNewSessionIdRef.current = sessionId;
              },
              submitPrompt,
            );
          pendingSubmissionRef.current = pendingSubmissionRef.current.then(
            send,
            send,
          );
          return;
        }
        void submitInput(
          result.submission,
          activeSessionId,
          activeSessionId === null ? pendingReasoning : null,
          catalog,
          client,
          loadCatalog,
          replaceInput,
          setError,
          selectedIndexRef.current,
          onCommandPanelOpen,
          true,
          undefined,
          submitPrompt,
        );
        return;
      }

      if (currentQueuedEdit?.retainedSendText !== undefined) return;
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
        applyEditor({ text: value, type: "insert" });
        selectIndex(0);
        setError(null);
      }
    },
    { isActive: !disabled },
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
    <Box flexDirection="column">
      {unsentSteer ? (
        <Text dimColor>Task stopped before your steer message was sent.</Text>
      ) : null}
      {steerNoticeRunId && steerNoticeRunId === activeRunId ? (
        <Text>
          Steer accepted · waiting for the active run’s next safe boundary
        </Text>
      ) : null}
      {queuedPrompts.length === 0 ? null : (
        <Box flexDirection="column" paddingX={1} width={layout.contentWidth}>
          <Text dimColor>Queued {queuedPrompts.length}</Text>
          {queuedPrompts.map((prompt, index) => (
            <Text
              dimColor={queuedEdit?.promptId !== prompt.promptId}
              key={prompt.promptId}
            >
              {(
                queueSelectionId
                  ? prompt.promptId === queueSelectionId
                  : index === Math.min(steerSelection, queuedPrompts.length - 1)
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
      {runtimeStatusLabel ? <Text dimColor>{runtimeStatusLabel}</Text> : null}
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
          Math.max(1, layout.contentWidth - 4),
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
      <Box flexDirection="column" width={layout.contentWidth}>
        {footerRows.map((row, index) => (
          <Text key={index} dimColor wrap="truncate-end">
            {row}
          </Text>
        ))}
      </Box>
      {error === null ? null : <Text color={theme.status.error}>{error}</Text>}
      <Completion
        catalog={catalog}
        input={editorText(editor)}
        selectedIndex={selectedIndex}
      />
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
  return editorViewport(editor, width, maxRows).map((row, index) => (
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
): Promise<void> {
  const text = input.trim();

  if (text === "") {
    return;
  }

  if (!text.startsWith("/")) {
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
    try {
      const receipt = await (submitPrompt
        ? submitPrompt(text, reasoning)
        : client.submitPromptAccepted(text, {
            clientRequestId: randomUUID(),
            reasoning,
            sessionId: activeSessionId ?? undefined,
          }));
      onAccepted?.(receipt.sessionId);
    } catch (caught) {
      setError(formatError(caught));
    }
    return;
  }

  let commandCatalog = catalog;
  if (commandCatalog === null) {
    if (!loadCatalog) {
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

  const result = resolveCommand(parseSlashInput(text), commandCatalog, {
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
