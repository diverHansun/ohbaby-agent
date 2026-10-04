import type { Key } from "ink";
import {
  editorText,
  type EditorAction,
  type EditorState,
} from "./editor-reducer.js";

export type EditorNavigation = EditorAction | { readonly type: "load-history" };

/** Called only after dialogs, queue selection and slash completion own their keys. */
export function editorNavigation(
  state: EditorState,
  key: Key,
  input: string,
  allowHistory = true,
): EditorNavigation | undefined {
  const first = state.cursor.row === 0;
  const last = state.cursor.row === state.lines.length - 1;
  if (key.pageUp) {
    // Never replace the transcript while moving around a non-empty draft.
    if (allowHistory && editorText(state) === "")
      return { type: "load-history" };
    return { type: first ? "move-home" : "move-up" };
  }
  if (key.pageDown) return { type: last ? "move-end" : "move-down" };
  if (key.upArrow)
    return { type: first && allowHistory ? "history-up" : "move-up" };
  if (key.downArrow)
    return { type: last && allowHistory ? "history-down" : "move-down" };
  if (key.leftArrow) return { type: "move-left" };
  if (key.rightArrow) return { type: "move-right" };
  if (key.home || (key.ctrl && (input === "a" || input === "\u0001")))
    return { type: "move-home" };
  if (key.end || (key.ctrl && (input === "e" || input === "\u0005")))
    return { type: "move-end" };
  return undefined;
}
