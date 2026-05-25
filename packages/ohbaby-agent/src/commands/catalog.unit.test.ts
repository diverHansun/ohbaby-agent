import { describe, expect, it } from "vitest";
import {
  buildCommandCatalog,
  filterCommandCatalogBySurface,
  validateUniqueAliases,
} from "./index.js";

describe("command catalog", () => {
  it("registers only MVP commands with real handlers", () => {
    expect(buildCommandCatalog().commands.map((command) => command.id)).toEqual(
      [
        "status",
        "tools",
        "abort",
        "exit",
        "model",
        "model.list",
        "model.current",
        "session",
        "session.new",
        "session.compact",
        "session.resume",
        "mode",
        "mode.agent",
        "mode.ask",
        "mode.plan",
        "permission",
        "permission.ask-before-edit",
        "permission.edit-automatically",
      ],
    );
  });

  it("declares canonical paths and aliases", () => {
    expect(buildCommandCatalog().commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "exit",
          aliases: [["quit"], ["q"]],
          path: ["exit"],
        }),
        expect.objectContaining({
          id: "model",
          parentBehavior: "none",
          path: ["model"],
        }),
        expect.objectContaining({
          id: "session",
          parentBehavior: "interaction",
          path: ["session"],
        }),
        expect.objectContaining({
          id: "session.new",
          aliases: [["new"]],
          path: ["session", "new"],
        }),
        expect.objectContaining({
          acceptsArguments: true,
          aliases: [["compact"]],
          argsHint: "[--session_id <id>] [--force]",
          id: "session.compact",
          path: ["session", "compact"],
        }),
        expect.objectContaining({
          acceptsArguments: true,
          aliases: [],
          argsHint: "--session_id <id>",
          id: "session.resume",
          path: ["resume"],
        }),
        expect.objectContaining({
          id: "mode",
          parentBehavior: "none",
          path: ["mode"],
        }),
        expect.objectContaining({
          id: "permission",
          parentBehavior: "none",
          path: ["permission"],
        }),
        expect.objectContaining({
          id: "permission.ask-before-edit",
          path: ["permission", "ask-before-edit"],
        }),
        expect.objectContaining({
          id: "permission.edit-automatically",
          path: ["permission", "edit-automatically"],
        }),
      ]),
    );
  });

  it("rejects duplicate command paths and aliases", () => {
    const catalog = buildCommandCatalog();
    expect(() => {
      validateUniqueAliases([
        ...catalog.commands,
        {
          ...catalog.commands[0],
          id: "duplicate.status",
          path: ["status"],
        },
      ]);
    }).toThrow("Duplicate command path or alias: status");
    expect(() => {
      validateUniqueAliases([
        ...catalog.commands,
        {
          ...catalog.commands[0],
          id: "duplicate.quit",
          path: ["duplicate"],
          aliases: [["quit"]],
        },
      ]);
    }).toThrow("Duplicate command path or alias: quit");
  });

  it("filters catalog by surface", () => {
    const catalog = buildCommandCatalog({
      extraCommands: [
        {
          id: "headless.only",
          path: ["headless-only"],
          argumentMode: "argv",
          category: "system",
          description: "headless only",
          source: "builtin",
          surfaces: ["headless"],
        },
      ],
    });

    expect(
      filterCommandCatalogBySurface(catalog, "tui").commands.some(
        (command) => command.id === "headless.only",
      ),
    ).toBe(false);
    expect(
      filterCommandCatalogBySurface(catalog, "headless").commands.some(
        (command) => command.id === "headless.only",
      ),
    ).toBe(true);
  });
});
