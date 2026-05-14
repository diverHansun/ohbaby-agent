import { describe, expect, it } from "vitest";
import {
  filterCommandCatalog,
  parseSlashInput,
  resolveCommand,
  type UiCommandCatalog,
} from "../index.js";

const catalog: UiCommandCatalog = {
  version: "catalog_1",
  commands: [
    {
      id: "model",
      path: ["model"],
      aliases: [],
      argumentMode: "argv",
      category: "model",
      description: "Choose a model",
      parentBehavior: "interaction",
      source: "builtin",
      surfaces: ["tui", "stdout"],
    },
    {
      id: "model.current",
      path: ["model", "current"],
      aliases: [["mc"]],
      argumentMode: "argv",
      category: "model",
      description: "Show current model",
      source: "builtin",
      surfaces: ["tui", "stdout"],
    },
    {
      id: "exit",
      path: ["exit"],
      aliases: [["quit"], ["q"]],
      argumentMode: "argv",
      category: "system",
      description: "Exit",
      source: "builtin",
      surfaces: ["tui", "stdout"],
    },
  ],
};

describe("resolveCommand", () => {
  it("resolves longest catalog path with remaining argv", () => {
    const parsed = parseSlashInput("/model current --json");
    const result = resolveCommand(catalog, parsed);

    expect(result).toMatchObject({
      ok: true,
      command: { id: "model.current" },
      argv: ["--json"],
      rawArgs: "--json",
      path: ["model", "current"],
    });
  });

  it("does not infer child commands from a parent command with args", () => {
    const parsed = parseSlashInput("/model gpt-5.5");

    expect(resolveCommand(catalog, parsed)).toEqual({
      ok: false,
      error: {
        code: "COMMAND_NOT_FOUND",
        message: 'Unknown command "/model gpt-5.5"',
      },
    });
  });

  it("resolves aliases declared by the catalog", () => {
    const result = resolveCommand(catalog, parseSlashInput("/quit"));

    expect(result).toMatchObject({
      ok: true,
      command: { id: "exit" },
      path: ["exit"],
      usedAlias: ["quit"],
    });
  });

  it("returns COMMAND_NOT_FOUND for unknown commands", () => {
    expect(resolveCommand(catalog, parseSlashInput("/wat"))).toEqual({
      ok: false,
      error: {
        code: "COMMAND_NOT_FOUND",
        message: 'Unknown command "/wat"',
      },
    });
  });
});

describe("filterCommandCatalog", () => {
  it("filters by surface and partial slash input", () => {
    expect(filterCommandCatalog(catalog, "/mo", { surface: "tui" })).toEqual([
      expect.objectContaining({ id: "model" }),
      expect.objectContaining({ id: "model.current" }),
    ]);
  });

  it("can match aliases for completion", () => {
    expect(filterCommandCatalog(catalog, "/qu", { surface: "tui" })).toEqual([
      expect.objectContaining({ id: "exit" }),
    ]);
  });
});
