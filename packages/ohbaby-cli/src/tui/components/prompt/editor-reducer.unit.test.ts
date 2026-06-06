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
