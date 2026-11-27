import { describe, expect, it } from "vitest";
import type { TuiCommandCatalog } from "../../store/snapshot.js";
import { createEditorState } from "./editor-reducer.js";
import { editorViewport } from "./editor-viewport.js";
import { rowPieces, skillNameEnd } from "./skill-highlight.js";

const catalog: TuiCommandCatalog = {
  version: "v1",
  commands: [
    {
      id: "compact",
      path: ["compact"],
      category: "session",
      description: "Compact",
      argumentMode: "argv",
      source: "builtin",
      surfaces: ["tui"],
    },
    {
      id: "skill.code-review",
      path: ["code-review"],
      category: "skills",
      description: "Review code",
      argumentMode: "raw",
      source: "skill",
      surfaces: ["tui"],
    },
  ],
};

/** The colored text of every visible row, for one draft. */
function colored(text: string, width: number, rows = 5): string[] {
  const state = createEditorState({ text });
  const end = skillNameEnd(state.lines[0] ?? "", catalog);
  return editorViewport(state, width, rows).map((row) =>
    rowPieces(row, end, true)
      .filter((piece) => piece.skill)
      .map((piece) => piece.text)
      .join(""),
  );
}

describe("TUI skill name color (T2)", () => {
  it("colors only a known skill at the start of the first line", () => {
    expect(skillNameEnd("/code-review 帮我", catalog)).toBe(12);
    expect(skillNameEnd("/Code-Review", catalog)).toBe(12);
    expect(skillNameEnd("/compact", catalog)).toBe(0);
    expect(skillNameEnd("/code-reviewer x", catalog)).toBe(0);
    expect(skillNameEnd(" /code-review", catalog)).toBe(0);
    expect(skillNameEnd("/code-review", null)).toBe(0);
  });

  it("leaves the request and later lines uncolored", () => {
    expect(colored("/code-review 帮我\n/code-review", 40)).toEqual([
      "/code-review",
      "",
    ]);
    expect(colored("hi\n/code-review", 40)).toEqual(["", ""]);
  });

  it("follows the name across a wrap and never colors the wrapped request", () => {
    expect(colored("/code-review abcdefgh", 8)).toEqual([
      "/code-re",
      "view",
      "",
    ]);
  });

  it("keeps the first visible row uncolored once the draft scrolls", () => {
    const text = `/code-review x\n${Array.from({ length: 8 }, (_, i) => `/code-review ${String(i)}`).join("\n")}`;
    expect(colored(text, 40, 3).every((piece) => piece === "")).toBe(true);
  });

  it("draws the cursor cell with the cursor inside the name", () => {
    const state = {
      ...createEditorState({ text: "/code-review x" }),
      cursor: { row: 0, col: 3 },
    };
    const [row] = editorViewport(state, 40, 5);
    expect(rowPieces(row, 12, true)).toEqual([
      { text: "/co", cursor: false, skill: true },
      { text: "d", cursor: true, skill: true },
      { text: "e-review", cursor: false, skill: true },
      { text: " x", cursor: false, skill: false },
    ]);
  });
});
