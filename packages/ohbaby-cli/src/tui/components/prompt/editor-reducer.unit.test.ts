import { describe, expect, it } from "vitest";
import {
  applyEditorAction,
  createEditorState,
  editorText,
} from "./editor-reducer.js";

describe("editorReducer", () => {
  it("inserts pasted multiline text at the cursor", () => {
    const result = applyEditorAction(createEditorState(), {
      text: "hello\nworld",
      type: "insert",
    });

    expect(result.state.lines).toEqual(["hello", "world"]);
    expect(result.state.cursor).toEqual({ col: 5, row: 1 });
    expect(editorText(result.state)).toBe("hello\nworld");
  });

  it("moves the cursor between lines and keeps the column where possible", () => {
    const start = createEditorState({ text: "first line\nsecond\n第三行" });
    expect(start.cursor).toEqual({ col: 3, row: 2 });
    const up = applyEditorAction(start, { type: "move-up" }).state;
    expect(up.cursor).toEqual({ col: 6, row: 1 });
    const upAgain = applyEditorAction(up, { type: "move-up" }).state;
    expect(upAgain.cursor).toEqual({ col: 6, row: 0 });
    expect(
      applyEditorAction(upAgain, { type: "move-up" }).state.cursor,
    ).toEqual({ col: 6, row: 0 });
    const clamped = applyEditorAction(
      { ...upAgain, preferredColumn: undefined, cursor: { col: 9, row: 0 } },
      { type: "move-down" },
    ).state;
    expect(clamped.cursor).toEqual({ col: 6, row: 1 });
    expect(
      applyEditorAction(clamped, { type: "move-down" }).state.cursor,
    ).toEqual({ col: 3, row: 2 });
  });

  it("restores the desired cell column after a short line and resets it after editing", () => {
    const start = createEditorState({ text: "abcdef\nx\nabcdef" });
    const short = applyEditorAction(start, { type: "move-up" }).state;
    expect(short.cursor).toEqual({ col: 1, row: 1 });
    expect(applyEditorAction(short, { type: "move-up" }).state.cursor).toEqual({
      col: 6,
      row: 0,
    });
    const edited = applyEditorAction(short, {
      type: "insert",
      text: "!",
    }).state;
    expect(applyEditorAction(edited, { type: "move-up" }).state.cursor).toEqual(
      { col: 2, row: 0 },
    );
  });

  it("keeps vertical moves on emoji, combining-mark and tab boundaries", () => {
    const start = createEditorState({ text: "👩‍💻éx\n\tZ\nabcd" });
    const tab = applyEditorAction(start, { type: "move-up" }).state;
    expect(tab.cursor).toEqual({ col: 1, row: 1 });
    const emoji = applyEditorAction(tab, { type: "move-up" }).state;
    expect(emoji.cursor).toEqual({ col: "👩‍💻éx".length, row: 0 });
    const atHome = applyEditorAction(emoji, { type: "move-home" }).state;
    const narrow = applyEditorAction(
      applyEditorAction(atHome, { type: "move-right" }).state,
      { type: "move-down" },
    ).state;
    // A two-cell target is inside a four-cell tab: land before it, not inside it.
    expect(narrow.cursor).toEqual({ col: 0, row: 1 });
  });

  it("backspaces across line boundaries", () => {
    const inserted = applyEditorAction(createEditorState(), {
      text: "hello\nworld",
      type: "insert",
    }).state;
    const result = applyEditorAction(inserted, { type: "backspace" });

    expect(result.state.lines).toEqual(["hello", "worl"]);
    expect(result.state.cursor).toEqual({ col: 4, row: 1 });
  });

  it("submits non-empty input, clears the editor, and stores history", () => {
    const inserted = applyEditorAction(createEditorState(), {
      text: "run tests",
      type: "insert",
    }).state;
    const result = applyEditorAction(inserted, { type: "submit" });

    expect(result.submission).toBe("run tests");
    expect(editorText(result.state)).toBe("");
    expect(result.state.history).toEqual(["run tests"]);
  });

  it("restores draft text after browsing history down to the end", () => {
    const submitted = applyEditorAction(
      applyEditorAction(createEditorState(), {
        text: "first",
        type: "insert",
      }).state,
      { type: "submit" },
    ).state;
    const draft = applyEditorAction(submitted, {
      text: "draft",
      type: "insert",
    }).state;

    const history = applyEditorAction(draft, { type: "history-up" }).state;
    const restored = applyEditorAction(history, { type: "history-down" }).state;

    expect(editorText(history)).toBe("first");
    expect(editorText(restored)).toBe("draft");
  });
});
