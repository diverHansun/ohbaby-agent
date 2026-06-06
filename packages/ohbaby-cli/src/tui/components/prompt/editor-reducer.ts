export interface EditorState {
  readonly cursor: EditorCursor;
  readonly draft: string | null;
  readonly history: readonly string[];
  readonly historyIndex: number;
  readonly lines: readonly string[];
}

export interface EditorCursor {
  readonly col: number;
  readonly row: number;
}

export type EditorAction =
  | { readonly text: string; readonly type: "insert" }
  | { readonly type: "backspace" }
  | { readonly type: "clear-line" }
  | { readonly type: "history-down" }
  | { readonly type: "history-up" }
  | { readonly type: "move-end" }
  | { readonly type: "move-home" }
  | { readonly type: "move-left" }
  | { readonly type: "move-right" }
  | { readonly type: "newline" }
  | { readonly type: "submit" };

export interface EditorReducerResult {
  readonly state: EditorState;
  readonly submission?: string;
}

export function createEditorState(
  input: {
    readonly history?: readonly string[];
    readonly text?: string;
  } = {},
): EditorState {
  const text = input.text ?? "";
  const lines = text.split("\n");
  const lastLine = lines.at(-1) ?? "";
  const history = input.history ?? [];

  return {
    cursor: { col: lastLine.length, row: lines.length - 1 },
    draft: null,
    history,
    historyIndex: history.length,
    lines,
  };
}

export function editorText(state: EditorState): string {
  return state.lines.join("\n");
}

export function applyEditorAction(
  state: EditorState,
  action: EditorAction,
): EditorReducerResult {
  switch (action.type) {
    case "insert":
      return { state: insertText(state, action.text) };
    case "newline":
      return { state: insertText(state, "\n") };
    case "backspace":
      return { state: backspace(state) };
    case "clear-line":
      return { state: clearCurrentLine(state) };
    case "move-left":
      return { state: moveLeft(state) };
    case "move-right":
      return { state: moveRight(state) };
    case "move-home":
      return { state: withCursor(state, { col: 0, row: state.cursor.row }) };
    case "move-end":
      return {
        state: withCursor(state, {
          col: lineAt(state, state.cursor.row).length,
          row: state.cursor.row,
        }),
      };
    case "history-up":
      return { state: historyUp(state) };
    case "history-down":
      return { state: historyDown(state) };
    case "submit":
      return submit(state);
  }
}

function insertText(state: EditorState, text: string): EditorState {
  if (text === "") {
    return state;
  }

  let next = state;
  for (const char of text.replace(/\r\n/gu, "\n")) {
    next = char === "\n" ? insertNewline(next) : insertChar(next, char);
  }
  return {
    ...next,
    draft: next.historyIndex === next.history.length ? next.draft : null,
    historyIndex: next.history.length,
  };
}

function insertChar(state: EditorState, char: string): EditorState {
  const lines = [...state.lines];
  const line = lineAt(state, state.cursor.row);
  lines[state.cursor.row] =
    `${line.slice(0, state.cursor.col)}${char}${line.slice(state.cursor.col)}`;
  return withLinesAndCursor(state, lines, {
    col: state.cursor.col + char.length,
    row: state.cursor.row,
  });
}

function insertNewline(state: EditorState): EditorState {
  const lines = [...state.lines];
  const line = lineAt(state, state.cursor.row);
  lines.splice(
    state.cursor.row,
    1,
    line.slice(0, state.cursor.col),
    line.slice(state.cursor.col),
  );
  return withLinesAndCursor(state, lines, {
    col: 0,
    row: state.cursor.row + 1,
  });
}

function backspace(state: EditorState): EditorState {
  if (state.cursor.col > 0) {
    const lines = [...state.lines];
    const line = lineAt(state, state.cursor.row);
    lines[state.cursor.row] =
      `${line.slice(0, state.cursor.col - 1)}${line.slice(state.cursor.col)}`;
    return withLinesAndCursor(state, lines, {
      col: state.cursor.col - 1,
      row: state.cursor.row,
    });
  }

  if (state.cursor.row === 0) {
    return state;
  }

  const lines = [...state.lines];
  const currentLine = lineAt(state, state.cursor.row);
  const previousLine = lineAt(state, state.cursor.row - 1);
  lines.splice(state.cursor.row - 1, 2, `${previousLine}${currentLine}`);
  return withLinesAndCursor(state, lines, {
    col: previousLine.length,
    row: state.cursor.row - 1,
  });
}

function clearCurrentLine(state: EditorState): EditorState {
  const lines = [...state.lines];
  lines[state.cursor.row] = "";
  return withLinesAndCursor(state, lines, { col: 0, row: state.cursor.row });
}

function moveLeft(state: EditorState): EditorState {
  if (state.cursor.col > 0) {
    return withCursor(state, {
      col: state.cursor.col - 1,
      row: state.cursor.row,
    });
  }
  if (state.cursor.row === 0) {
    return state;
  }
  return withCursor(state, {
    col: lineAt(state, state.cursor.row - 1).length,
    row: state.cursor.row - 1,
  });
}

function moveRight(state: EditorState): EditorState {
  const currentLine = lineAt(state, state.cursor.row);
  if (state.cursor.col < currentLine.length) {
    return withCursor(state, {
      col: state.cursor.col + 1,
      row: state.cursor.row,
    });
  }
  if (state.cursor.row >= state.lines.length - 1) {
    return state;
  }
  return withCursor(state, { col: 0, row: state.cursor.row + 1 });
}

function historyUp(state: EditorState): EditorState {
  if (state.history.length === 0) {
    return state;
  }
  const nextIndex = Math.max(0, state.historyIndex - 1);
  const draft =
    state.historyIndex === state.history.length
      ? editorText(state)
      : state.draft;
  return loadText(state, state.history[nextIndex], {
    draft,
    historyIndex: nextIndex,
  });
}

function historyDown(state: EditorState): EditorState {
  if (state.historyIndex >= state.history.length) {
    return state;
  }
  const nextIndex = state.historyIndex + 1;
  if (nextIndex >= state.history.length) {
    return loadText(state, state.draft ?? "", {
      draft: null,
      historyIndex: state.history.length,
    });
  }
  return loadText(state, state.history[nextIndex], {
    draft: state.draft,
    historyIndex: nextIndex,
  });
}

function submit(state: EditorState): EditorReducerResult {
  const submission = editorText(state).trim();
  if (submission === "") {
    return { state };
  }

  const history = [...state.history, submission];
  return {
    state: createEditorState({ history }),
    submission,
  };
}

function loadText(
  state: EditorState,
  text: string,
  patch: Pick<EditorState, "draft" | "historyIndex">,
): EditorState {
  const loaded = createEditorState({ history: state.history, text });
  return {
    ...loaded,
    draft: patch.draft,
    historyIndex: patch.historyIndex,
  };
}

function withLinesAndCursor(
  state: EditorState,
  lines: readonly string[],
  cursor: EditorCursor,
): EditorState {
  return {
    ...state,
    cursor: clampCursor(lines, cursor),
    lines,
  };
}

function withCursor(state: EditorState, cursor: EditorCursor): EditorState {
  return {
    ...state,
    cursor: clampCursor(state.lines, cursor),
  };
}

function clampCursor(
  lines: readonly string[],
  cursor: EditorCursor,
): EditorCursor {
  const row = Math.min(Math.max(0, cursor.row), lines.length - 1);
  const col = Math.min(Math.max(0, cursor.col), (lines[row] ?? "").length);
  return { col, row };
}

function lineAt(state: EditorState, row: number): string {
  return state.lines[row] ?? "";
}
