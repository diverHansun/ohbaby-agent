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

const sessionCatalog: UiCommandCatalog = {
  version: "session_catalog",
  commands: [
    {
      aliases: [],
      argumentMode: "argv",
      category: "session",
      description: "Choose a session",
      id: "session",
      parentBehavior: "interaction",
      path: ["session"],
      source: "builtin",
      surfaces: ["tui", "stdout", "headless"],
    },
    {
      acceptsArguments: true,
      aliases: [],
      argumentMode: "argv",
      category: "session",
      description: "Resume a session",
      id: "session.resume",
      path: ["resume"],
      source: "builtin",
      surfaces: ["tui", "stdout", "headless"],
    },
  ],
};

const permissionCatalog: UiCommandCatalog = {
  version: "permission_catalog",
  commands: [
    {
      aliases: [],
      argumentMode: "argv",
      category: "permission",
      description: "Choose permission level",
      id: "permission",
      parentBehavior: "none",
      path: ["permission"],
      source: "builtin",
      surfaces: ["tui", "stdout", "headless"],
    },
    {
      aliases: [],
      argumentMode: "argv",
      category: "permission",
      description: "Use default permission level",
      id: "permission.default",
      path: ["permission", "default"],
      source: "builtin",
      surfaces: ["tui", "stdout", "headless"],
    },
    {
      aliases: [],
      argumentMode: "argv",
      category: "permission",
      description: "Use full access permission level",
      id: "permission.full-access",
      path: ["permission", "full-access"],
      source: "builtin",
      surfaces: ["tui", "stdout", "headless"],
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

  it("resolves only the public session and resume command paths", () => {
    const sessionResult = resolveCommand(
      sessionCatalog,
      parseSlashInput("/session"),
    );
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) {
      throw new Error("expected /session to resolve");
    }
    expect(sessionResult.command.id).toBe("session");
    expect(sessionResult.path).toEqual(["session"]);

    const resumeResult = resolveCommand(
      sessionCatalog,
      parseSlashInput("/resume session_1"),
    );
    expect(resumeResult.ok).toBe(true);
    if (!resumeResult.ok) {
      throw new Error("expected /resume to resolve");
    }
    expect(resumeResult.argv).toEqual(["session_1"]);
    expect(resumeResult.command.id).toBe("session.resume");
    expect(resumeResult.path).toEqual(["resume"]);
    expect(resumeResult.rawArgs).toBe("session_1");
    expect(
      resolveCommand(sessionCatalog, parseSlashInput("/session list")),
    ).toMatchObject({
      error: { code: "COMMAND_NOT_FOUND" },
      ok: false,
    });
    expect(
      resolveCommand(
        sessionCatalog,
        parseSlashInput("/session resume session_1"),
      ),
    ).toMatchObject({
      error: { code: "COMMAND_NOT_FOUND" },
      ok: false,
    });
  });

  it("does not resolve removed mode commands through permission", () => {
    for (const input of ["/permission plan", "/permission auto", "/mode"]) {
      expect(resolveCommand(permissionCatalog, parseSlashInput(input))).toEqual(
        {
          ok: false,
          error: {
            code: "COMMAND_NOT_FOUND",
            message: `Unknown command "${input}"`,
          },
        },
      );
    }
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

  it("filters session and resume without exposing removed session subcommands", () => {
    expect(
      filterCommandCatalog(sessionCatalog, "/ses", { surface: "tui" }),
    ).toEqual([expect.objectContaining({ id: "session" })]);
    expect(
      filterCommandCatalog(sessionCatalog, "/res", { surface: "tui" }),
    ).toEqual([expect.objectContaining({ id: "session.resume" })]);
    expect(
      filterCommandCatalog(sessionCatalog, "/session r", { surface: "tui" }),
    ).toEqual([]);
  });
});
