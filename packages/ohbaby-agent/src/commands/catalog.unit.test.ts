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
        "session.list",
        "session.resume",
        "mode",
        "mode.agent",
        "mode.ask",
        "mode.plan",
        "mode.auto-edit",
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
          acceptsArguments: true,
          aliases: [["resume"]],
          argsHint: "--session_id <id>",
          id: "session.resume",
          path: ["session", "resume"],
        }),
        expect.objectContaining({
          id: "mode",
          parentBehavior: "none",
          path: ["mode"],
        }),
        expect.objectContaining({
          id: "mode.auto-edit",
          path: ["mode", "auto-edit"],
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
