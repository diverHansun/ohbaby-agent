import { randomUUID } from "node:crypto";
import { Box, Text, useInput } from "ink";
import type {
  CoreAPI,
  UiCommandInvocation,
  UiGoal,
  UiPermissionState,
  UiPromptQueueClient,
  UiPromptSubmission,
} from "ohbaby-sdk";
import { useRef, useState } from "react";
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

export interface PromptProps {
  readonly activeSessionId: string | null;
  readonly catalog: TuiCommandCatalog | null;
  readonly client: CoreAPI & Partial<UiPromptQueueClient>;
  readonly contextWindowUsage?: string;
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

export function Prompt({
  activeSessionId,
  catalog,
  client,
  contextWindowUsage = "",
  disabled,
  goalStatus,
  loadCatalog,
  onCommandPanelOpen,
  permission,
  queuedPrompts = [],
  runtimeStatusLabel,
}: PromptProps): ReactElement {
  const theme = useTheme();
  const layout = useTuiLayout();
  const [editor, setEditor] = useState<EditorState>(() => createEditorState());
  const [error, setError] = useState<string | null>(null);
  const [queuedEdit, setQueuedEdit] = useState<{
    readonly editLeaseId: string;
    readonly originalInput: string;
    readonly promptId: string;
  } | null>(null);
  const [queuedMutationPending, setQueuedMutationPending] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const editorRef = useRef(editor);
  const queuedEditRef = useRef(queuedEdit);
  const queuedMutationPendingRef = useRef(false);
  const lastLeaseRenewalAtRef = useRef(0);
  const selectedIndexRef = useRef(0);

  const replaceEditor = (nextEditor: EditorState): void => {
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

  const replaceQueuedMutationPending = (next: boolean): void => {
    queuedMutationPendingRef.current = next;
    setQueuedMutationPending(next);
  };

  const restoreQueuedEditInput = (): void => {
    const current = queuedEditRef.current;
    if (!current) return;
    replaceInput(current.originalInput);
    replaceQueuedEdit(null);
  };

  const renewQueuedEditLease = (): void => {
    const current = queuedEditRef.current;
    if (!current || !client.renewPromptEditLease) return;
    const now = Date.now();
    if (now - lastLeaseRenewalAtRef.current < 20_000) return;
    lastLeaseRenewalAtRef.current = now;
    void client
      .renewPromptEditLease({
        editLeaseId: current.editLeaseId,
        ownerClientId: "tui",
        promptId: current.promptId,
      })
      .catch((caught: unknown) => {
        replaceQueuedEdit(null);
        setError(
          `${formatError(caught)}. Edited text was preserved and can be sent as a new prompt.`,
        );
      });
  };

  useInput(
    (value, key) => {
      if (queuedMutationPendingRef.current) return;
      const currentInput = editorText(editorRef.current);
      const candidates = getSlashCompletionCandidates(currentInput, catalog);

      if (key.meta && key.upArrow) {
        if (queuedEditRef.current) return;
        const prompt = queuedPrompts.at(-1);
        if (!prompt || !client.acquirePromptEditLease) return;
        setError(null);
        replaceQueuedMutationPending(true);
        void client
          .acquirePromptEditLease({
            ownerClientId: "tui",
            promptId: prompt.promptId,
          })
          .then((lease) => {
            replaceQueuedEdit({
              editLeaseId: lease.editLeaseId,
              originalInput: currentInput,
              promptId: prompt.promptId,
            });
            lastLeaseRenewalAtRef.current = Date.now();
            replaceInput(prompt.text);
          })
          .catch((caught: unknown) => {
            setError(formatError(caught));
          })
          .finally(() => {
            replaceQueuedMutationPending(false);
          });
        return;
      }

      const currentQueuedEdit = queuedEditRef.current;
      if (
        currentQueuedEdit &&
        key.ctrl &&
        (value === "d" || value === "\x04")
      ) {
        if (!client.cancelQueuedPrompt) return;
        replaceQueuedMutationPending(true);
        void client
          .cancelQueuedPrompt({
            editLeaseId: currentQueuedEdit.editLeaseId,
            promptId: currentQueuedEdit.promptId,
          })
          .then(restoreQueuedEditInput)
          .catch((caught: unknown) => {
            setError(formatError(caught));
          })
          .finally(() => {
            replaceQueuedMutationPending(false);
          });
        return;
      }

      if (currentQueuedEdit && key.escape) {
        void client
          .releasePromptEditLease?.({
            editLeaseId: currentQueuedEdit.editLeaseId,
            promptId: currentQueuedEdit.promptId,
          })
          .catch(() => undefined);
        restoreQueuedEditInput();
        return;
      }

      if (key.return) {
        if (key.shift) {
          if (currentQueuedEdit) renewQueuedEditLease();
          applyEditor({ type: "newline" });
          return;
        }

        if (currentQueuedEdit) {
          if (!client.editQueuedPrompt || currentInput.trim() === "") return;
          replaceQueuedMutationPending(true);
          void client
            .editQueuedPrompt({
              editLeaseId: currentQueuedEdit.editLeaseId,
              promptId: currentQueuedEdit.promptId,
              text: currentInput.trim(),
            })
            .then(restoreQueuedEditInput)
            .catch((caught: unknown) => {
              setError(formatError(caught));
            })
            .finally(() => {
              replaceQueuedMutationPending(false);
            });
          return;
        }

        const result = applyEditor({ type: "submit" });
        if (result.submission === undefined) {
          return;
        }
        void submitInput(
          result.submission,
          activeSessionId,
          catalog,
          client,
          loadCatalog,
          replaceInput,
          setError,
          selectedIndexRef.current,
          onCommandPanelOpen,
        );
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

  const dockStatus = formatDockStatus({
    activeSessionId,
    permission,
    queuedPromptCount: queuedPrompts.length,
    runtimeStatusLabel,
  });
  const goalStatusColor =
    goalStatus === "active" ? theme.status.accent : theme.status.warning;

  return (
    <Box flexDirection="column">
      {queuedPrompts.length === 0 ? null : (
        <Box flexDirection="column" paddingX={1} width={layout.contentWidth}>
          <Text dimColor>Queued {queuedPrompts.length}</Text>
          {queuedPrompts.map((prompt) => (
            <Text
              dimColor={queuedEdit?.promptId !== prompt.promptId}
              key={prompt.promptId}
            >
              ↳ {prompt.text.replace(/\s+/gu, " ").trim()}
              {queuedEdit?.promptId === prompt.promptId ? " · editing" : ""}
            </Text>
          ))}
          <Text dimColor>Alt+↑ edit latest · Ctrl+D cancel while editing</Text>
        </Box>
      )}
      <Box
        borderColor={theme.border}
        borderStyle="round"
        flexDirection="column"
        paddingX={1}
        width={layout.contentWidth}
      >
        {renderEditorLines(editor, disabled, theme.cursor)}
      </Box>
      {queuedEdit ? (
        <Text dimColor>
          {queuedMutationPending
            ? "Updating queued prompt…"
            : "Enter save · Ctrl+D cancel prompt · Esc keep original"}
        </Text>
      ) : null}
      {dockStatus === "" &&
      contextWindowUsage === "" &&
      goalStatus === undefined ? null : (
        <Box justifyContent="space-between">
          <Box>
            {goalStatus === undefined ? null : (
              <Text color={goalStatusColor}>goal {goalStatus}</Text>
            )}
            {goalStatus !== undefined && dockStatus !== "" ? (
              <Text dimColor>{" · "}</Text>
            ) : null}
            <Text dimColor>{dockStatus}</Text>
          </Box>
          {contextWindowUsage === "" ? null : (
            <Text dimColor>{contextWindowUsage}</Text>
          )}
        </Box>
      )}
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
): readonly ReactElement[] {
  const isEmpty = editorText(editor).length === 0;
  return editor.lines.map((line, index) => (
    <Text key={String(index)}>
      <Text dimColor={disabled}>{index === 0 ? "> " : "  "}</Text>
      {disabled && isEmpty && index === 0 ? (
        <Text dimColor>paused</Text>
      ) : (
        renderEditorLineText({
          cursorColor,
          editor,
          enabled: !disabled,
          index,
          line,
        })
      )}
    </Text>
  ));
}

function renderEditorLineText(input: {
  readonly cursorColor: string;
  readonly editor: EditorState;
  readonly enabled: boolean;
  readonly index: number;
  readonly line: string;
}): ReactElement {
  if (!input.enabled || input.editor.cursor.row !== input.index) {
    return <Text>{input.line}</Text>;
  }

  const cursorColumn = input.editor.cursor.col;
  const cursorChar =
    cursorColumn >= input.line.length
      ? " "
      : input.line.slice(cursorColumn, cursorColumn + 1);
  return (
    <Text>
      {input.line.slice(0, cursorColumn)}
      <Text color={input.cursorColor} inverse>
        {cursorChar}
      </Text>
      {input.line.slice(cursorColumn + cursorChar.length)}
    </Text>
  );
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

function formatDockStatus(input: {
  readonly activeSessionId: string | null;
  readonly permission?: UiPermissionState;
  readonly queuedPromptCount: number;
  readonly runtimeStatusLabel?: string;
}): string {
  const parts: string[] = [];
  if (input.runtimeStatusLabel) {
    parts.push(input.runtimeStatusLabel);
  }
  if (input.queuedPromptCount > 0) {
    parts.push(
      input.queuedPromptCount === 1
        ? "Queued"
        : `Queued ${String(input.queuedPromptCount)}`,
    );
  }
  if (input.permission) {
    parts.push(input.permission.mode, input.permission.level);
  }
  if (input.activeSessionId) {
    parts.push(input.activeSessionId);
  }
  return parts.join(" · ");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Command failed";
}

async function submitInput(
  input: string,
  activeSessionId: string | null,
  catalog: TuiCommandCatalog | null,
  client: CoreAPI & Partial<UiPromptQueueClient>,
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
): Promise<void> {
  const text = input.trim();

  if (text === "") {
    return;
  }

  if (!text.startsWith("/")) {
    setError(null);
    replaceInput("");
    void client
      .submitPrompt(text, {
        clientRequestId: randomUUID(),
        sessionId: activeSessionId ?? undefined,
      })
      .catch((caught: unknown) => {
        setError(formatError(caught));
      });
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
