import { Box, Text, useInput } from "ink";
import type { CoreAPI, UiPermissionState } from "ohbaby-sdk";
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

export interface PromptProps {
  readonly activeSessionId: string | null;
  readonly catalog: TuiCommandCatalog | null;
  readonly client: CoreAPI;
  readonly contextWindowUsage?: string;
  readonly disabled: boolean;
  readonly loadCatalog?: () => Promise<TuiCommandCatalog>;
  readonly permission?: UiPermissionState;
  readonly runtimeStatusLabel?: string;
}

export function Prompt({
  activeSessionId,
  catalog,
  client,
  contextWindowUsage = "",
  disabled,
  loadCatalog,
  permission,
  runtimeStatusLabel,
}: PromptProps): ReactElement {
  const theme = useTheme();
  const layout = useTuiLayout();
  const [editor, setEditor] = useState<EditorState>(() => createEditorState());
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const editorRef = useRef(editor);
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

  useInput(
    (value, key) => {
      const currentInput = editorText(editorRef.current);
      const candidates = getSlashCompletionCandidates(currentInput, catalog);

      if (key.return) {
        if (key.shift) {
          applyEditor({ type: "newline" });
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
        );
        return;
      }

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
    runtimeStatusLabel,
  });

  return (
    <Box flexDirection="column">
      <Box
        borderColor={theme.border}
        borderStyle="round"
        flexDirection="column"
        paddingX={1}
        width={layout.contentWidth}
      >
        {renderEditorLines(editor, disabled, theme.cursor)}
      </Box>
      {dockStatus === "" && contextWindowUsage === "" ? null : (
        <Box justifyContent="space-between">
          <Text dimColor>{dockStatus}</Text>
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
  readonly runtimeStatusLabel?: string;
}): string {
  const parts: string[] = [];
  if (input.runtimeStatusLabel) {
    parts.push(input.runtimeStatusLabel);
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
  client: CoreAPI,
  loadCatalog: (() => Promise<TuiCommandCatalog>) | undefined,
  replaceInput: (nextInput: string) => void,
  setError: (message: string | null) => void,
  selectedIndex: number,
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
      void client
        .executeCommand(selectedResult.invocation)
        .catch((caught: unknown) => {
          setError(formatError(caught));
        });
      return;
    }
  }

  if (result.kind !== "resolved") {
    setError(result.reason);
    return;
  }

  setError(null);
  replaceInput("");
  void client.executeCommand(result.invocation).catch((caught: unknown) => {
    setError(formatError(caught));
  });
}
