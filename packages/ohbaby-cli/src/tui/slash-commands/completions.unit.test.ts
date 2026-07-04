import { describe, expect, it } from "vitest";
import type { TuiCommandCatalog, TuiCommandSpec } from "../store/snapshot.js";
import {
  getSlashCompletion,
  getSlashCompletionCandidates,
  getSlashCompletionPageIndex,
  getSlashCompletionWindow,
} from "./completions.js";
import { formatCommandHint } from "./hints.js";

describe("slash command completions", () => {
  it("keeps the full candidate pool separate from the visible hint window", () => {
    const catalog: TuiCommandCatalog = {
      commands: Array.from({ length: 8 }, (_, index) =>
        command({
          description: `Command ${String(index)}`,
          id: `cmd.${String(index)}`,
          path: [`cmd${String(index)}`],
        }),
      ),
      version: "many",
    };

    const candidates = getSlashCompletionCandidates("/", catalog);
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "cmd.0",
      "cmd.1",
      "cmd.2",
      "cmd.3",
      "cmd.4",
      "cmd.5",
      "cmd.6",
      "cmd.7",
    ]);

    expect(
      getSlashCompletionWindow("/", catalog, 6).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["cmd.2", "cmd.3", "cmd.4", "cmd.5", "cmd.6", "cmd.7"]);
  });

  it("pages by visible windows instead of modulo stepping by hint count", () => {
    expect(getSlashCompletionPageIndex(12, 0, "next")).toBe(6);
    expect(getSlashCompletionPageIndex(12, 6, "next")).toBe(0);
    expect(getSlashCompletionPageIndex(8, 0, "previous")).toBe(2);
    expect(getSlashCompletionPageIndex(8, 6, "next")).toBe(0);
  });

  it("completes the currently selected candidate", () => {
    const catalog: TuiCommandCatalog = {
      commands: [
        command({
          description: "Start a new session",
          id: "new",
          path: ["new"],
        }),
        command({
          description: "List MCP server status",
          id: "mcps",
          path: ["mcps"],
        }),
      ],
      version: "selected",
    };

    expect(getSlashCompletion("/", catalog, 1)).toBe("/mcps ");
  });

  it("shows argsHint in slash hints for command families such as /goal", () => {
    expect(
      formatCommandHint(
        command({
          acceptsArguments: true,
          argsHint: "[<objective> | status | budget --turns N]",
          description: "Create and control a long-running goal",
          id: "goal",
          path: ["goal"],
        }),
      ),
    ).toContain("/goal [<objective> | status | budget --turns N]");
  });
});

function command(
  input: Pick<TuiCommandSpec, "description" | "id" | "path"> &
    Partial<TuiCommandSpec>,
): TuiCommandSpec {
  return {
    argumentMode: "argv",
    category: "system",
    source: "builtin",
    surfaces: ["tui"],
    ...input,
  };
}
