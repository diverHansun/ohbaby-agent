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
        "exit",
        "help",
        "models",
        "sessions",
        "new",
        "compact",
        "resume",
        "permission",
      ],
    );
  });

  it("gives every visible command a title", () => {
    for (const command of buildCommandCatalog().commands) {
      expect(command.title).toBeTruthy();
    }
  });

  it("does not expose removed slash commands", () => {
    expect(
      buildCommandCatalog().commands.map((command) => command.id),
    ).not.toEqual(
      expect.arrayContaining([
        "tools",
        "abort",
        "model",
        "model.list",
        "model.current",
        "session",
        "session.new",
        "session.compact",
        "session.resume",
        "permission.default",
        "permission.full-access",
      ]),
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
          aliases: [["?"]],
          id: "help",
          path: ["help"],
        }),
        expect.objectContaining({
          id: "models",
          parentBehavior: "interaction",
          path: ["models"],
        }),
        expect.objectContaining({
          id: "sessions",
          parentBehavior: "interaction",
          path: ["sessions"],
        }),
        expect.objectContaining({
          id: "new",
          aliases: [],
          path: ["new"],
        }),
        expect.objectContaining({
          acceptsArguments: true,
          aliases: [],
          argsHint: "[--session_id <id>] [--force]",
          id: "compact",
          path: ["compact"],
        }),
        expect.objectContaining({
          acceptsArguments: true,
          aliases: [],
          argsHint: "--session_id <id>",
          id: "resume",
          path: ["resume"],
        }),
        expect.objectContaining({
          id: "permission",
          parentBehavior: "interaction",
          path: ["permission"],
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
