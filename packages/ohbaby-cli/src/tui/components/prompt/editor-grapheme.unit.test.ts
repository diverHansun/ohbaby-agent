import { describe, expect, it } from "vitest";
import {
  applyEditorAction,
  createEditorState,
  editorText,
} from "./editor-reducer.js";
import { editorViewport } from "./editor-viewport.js";

describe("complete grapheme editing", () => {
  it.each(["👨‍👩‍👧‍👦", "👍🏽", "🇹🇼", "e\u0301", "😀"])(
    "moves and deletes %s as one unit",
    (text) => {
      const original = createEditorState({ text: `a${text}z` });
      const beforeZ = applyEditorAction(original, { type: "move-left" }).state;
      const beforeCluster = applyEditorAction(beforeZ, {
        type: "move-left",
      }).state;
      expect(beforeCluster.cursor.col).toBe(1);
      expect(
        applyEditorAction(beforeCluster, { type: "move-right" }).state.cursor,
      ).toEqual(beforeZ.cursor);
      expect(
        editorText(applyEditorAction(beforeZ, { type: "backspace" }).state),
      ).toBe("az");
    },
  );
  it("repairs every interior cursor to the next complete boundary", () => {
    const state = {
      ...createEditorState({ text: "a👩‍💻z" }),
      cursor: { row: 0, col: 3 },
    };
    expect(
      editorText(applyEditorAction(state, { type: "newline" }).state),
    ).toBe("a👩‍💻\nz");
    expect(
      editorText(applyEditorAction(state, { type: "insert", text: "!" }).state),
    ).toBe("a👩‍💻!z");
  });
  it("keeps the draft exact while retaining established trim on submission", () => {
    const text = " \t中文\nend  ";
    expect(
      applyEditorAction(createEditorState({ text }), { type: "submit" })
        .submission,
    ).toBe(text.trim());
  });
  it("projects tabs to four-column stops and never invents a zero-width cursor", () => {
    expect(
      editorViewport(createEditorState({ text: "a\tb" }), 10, 4)[0]?.text,
    ).toBe("a   b ");
    expect(editorViewport(createEditorState({ text: "中文" }), 0, 4)).toEqual([
      { text: "", resizeRequired: true },
    ]);
    expect(
      editorViewport(createEditorState({ text: "中" }), 1, 4)[0],
    ).toMatchObject({ text: "…", resizeRequired: true });
  });
});

it("uses Ink width semantics for a single regional indicator and fills narrow tab continuations", () => {
  expect(
    editorViewport(createEditorState({ text: "🇹" }), 1, 4)[0],
  ).toMatchObject({ text: "🇹" });
  expect(
    editorViewport(createEditorState({ text: "a\tb" }), 3, 4).map(
      (row) => row.text,
    ),
  ).toEqual(["a  ", " b "]);
});
