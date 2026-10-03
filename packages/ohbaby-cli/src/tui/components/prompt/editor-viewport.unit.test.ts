import { describe, expect, it } from "vitest";
import {
  createEditorState,
  applyEditorAction,
  editorText,
} from "./editor-reducer.js";
import { editorViewport } from "./editor-viewport.js";
import { visibleWidth } from "../../render/wrap.js";

describe("editor display viewport", () => {
  it("bounds physical rows around the cursor without mutating the multiline draft", () => {
    const text = Array.from(
      { length: 30 },
      (_, index) => `line ${String(index)}`,
    ).join("\n");
    const state = createEditorState({ text });
    const rows = editorViewport(state, 20, 5);
    expect(rows).toHaveLength(5);
    expect(rows[0]?.text).toBe("line 25");
    expect(rows[0]?.hiddenBefore).toBe(true);
    expect(rows.at(-1)).toEqual({
      text: "line 29 ",
      cursorStart: 7,
      cursorEnd: 8,
    });
    expect(editorText(state)).toBe(text);
    expect(applyEditorAction(state, { type: "submit" }).submission).toBe(text);
  });
  it("wraps long CJK and joined emoji into bounded physical rows and follows Home/End", () => {
    const text = `start${"中文❤️👩‍💻".repeat(20)}end`;
    const state = createEditorState({ text });
    const rows = editorViewport(state, 12, 3);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => visibleWidth(row.text) <= 12)).toBe(true);
    expect(rows.map((row) => row.text).join("")).toContain("end");
    expect(rows.at(-1)?.cursorStart).toBeDefined();
    const home = applyEditorAction(state, { type: "move-home" }).state;
    const beginning = editorViewport(home, 12, 3);
    expect(beginning[0]?.text).toContain("start");
    expect(beginning[0]?.cursorStart).toBe(0);
    expect(beginning[0]?.hiddenBefore).toBeUndefined();
    expect(editorText(home)).toBe(text);
    expect(
      editorViewport(
        applyEditorAction(home, { type: "move-end" }).state,
        12,
        3,
      ),
    ).toEqual(rows);
  });
  it("moves the end cursor to a new physical row at a width boundary", () => {
    expect(editorViewport(createEditorState({ text: "中文❤️" }), 6, 2)).toEqual(
      [{ text: "中文❤️" }, { text: " ", cursorStart: 0, cursorEnd: 1 }],
    );
  });
  it("highlights a whole grapheme when an existing cursor offset falls inside one", () => {
    const state = {
      ...createEditorState({ text: "👩‍💻x" }),
      cursor: { row: 0, col: 1 },
    };
    expect(editorViewport(state, 6, 2)).toEqual([
      { text: "👩‍💻x", cursorStart: 0, cursorEnd: 5 },
    ]);
    expect(state.cursor.col).toBe(1);
  });
});
