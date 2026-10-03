import { describe, expect, it } from "vitest";
import { createInputStream } from "./input-stream.js";
import {
  applyEditorAction,
  createEditorState,
  editorText,
} from "./editor-reducer.js";

describe("text input streaming", () => {
  it("normalizes CRLF across event boundaries", () => {
    const stream = createInputStream();
    expect(["one\r", "\ntwo\r", "\nthree"].map(stream.push).join("")).toBe(
      "one\ntwo\nthree",
    );
  });
  it("keeps suffix fragments and surrogate fragments equivalent to one text insertion", () => {
    const text = "中文👨‍👩‍👧‍👦👍🏽🇹🇼e\u0301";
    const stream = createInputStream();
    let state = createEditorState();
    // Intentionally split UTF-16 surrogate pairs as well as cluster suffixes.
    for (const char of text.split(""))
      state = applyEditorAction(state, {
        type: "insert",
        text: stream.push(char),
      }).state;
    expect(editorText(state)).toBe(text);
    expect(state.cursor.col).toBe(text.length);
    expect(
      editorText(applyEditorAction(state, { type: "backspace" }).state),
    ).toBe(text.slice(0, -2));
  });
});
