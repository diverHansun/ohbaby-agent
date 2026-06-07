import { describe, expect, it } from "vitest";
import type { TuiCommandCatalog, TuiCommandSpec } from "../store/snapshot.js";
import {
  getSlashCompletionCandidates,
  getSlashCompletionPageIndex,
  getSlashCompletionWindow,
} from "./completions.js";

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
