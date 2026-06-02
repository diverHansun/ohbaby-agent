import { describe, expect, it } from "vitest";
import {
  filterSlashCommandCatalog as filterCommandCatalog,
  parseSlashCommandInput as parseSlashInput,
  resolveSlashCommand as resolveCommand,
  type UiSlashCommandCatalog as UiCommandCatalog,
} from "../index.js";

const catalog: UiCommandCatalog = {
  version: "commands-v3",
  commands: [
    {
      aliases: [],
      argumentMode: "argv",
      category: "model",
      description: "Show and switch active model",
      id: "models",
      path: ["models"],
      source: "builtin",
      surfaces: ["tui", "stdout", "headless"],
      title: "Models",
    },
    {
      aliases: [],
      argumentMode: "argv",
      category: "model",
      description: "Headless only models",
      id: "models.headless",
      path: ["models-headless"],
      source: "builtin",
      surfaces: ["headless"],
      title: "Headless Models",
    },
    {
      aliases: [["quit"], ["q"]],
      argumentMode: "argv",
      category: "system",
      description: "Exit",
      id: "exit",
      path: ["exit"],
      source: "builtin",
      surfaces: ["tui", "stdout"],
      title: "Exit",
    },
    {
      aliases: [],
      argumentMode: "argv",
      category: "session",
      description: "Choose a session",
      id: "sessions",
      parentBehavior: "interaction",
      path: ["sessions"],
      source: "builtin",
      surfaces: ["tui", "stdout", "headless"],
      title: "Sessions",
    },
    {
      acceptsArguments: true,
      aliases: [],
      argumentMode: "argv",
      argsHint: "--session_id <id>",
      category: "session",
      description: "Resume a session",
      id: "resume",
      path: ["resume"],
      source: "builtin",
      surfaces: ["tui", "stdout", "headless"],
      title: "Resume",
    },
    {
      acceptsArguments: true,
      aliases: [["project", "load"]],
      argumentMode: "argv",
      argsHint: "<path>",
      category: "project",
      description: "Open a project",
      id: "project.open",
      path: ["project", "open"],
      source: "builtin",
      surfaces: ["tui", "stdout", "headless"],
      title: "Open Project",
    },
    {
      aliases: [],
      argumentMode: "argv",
      category: "permission",
      description: "Choose permission level",
      id: "permission",
      parentBehavior: "interaction",
      path: ["permission"],
      source: "builtin",
      surfaces: ["tui", "stdout", "headless"],
      title: "Permission",
    },
  ],
};

describe("resolveCommand", () => {
  it("resolves /models as the single model command", () => {
    expect(
      resolveCommand(catalog, parseSlashInput("/models"), { surface: "tui" }),
    ).toMatchObject({
      ok: true,
      argv: [],
      command: { id: "models" },
      path: ["models"],
      rawArgs: "",
    });
  });

  it("rejects unaccepted argv on non-argument commands", () => {
    expect(
      resolveCommand(catalog, parseSlashInput("/models gpt-5.5"), {
        surface: "tui",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "COMMAND_NOT_FOUND",
        message: 'Unknown command "/models gpt-5.5"',
      },
    });
  });

  it("rejects commands unavailable on the requested surface", () => {
    expect(
      resolveCommand(catalog, parseSlashInput("/models-headless"), {
        surface: "tui",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "COMMAND_NOT_AVAILABLE_ON_SURFACE" },
    });
  });

  it("resolves aliases declared by the catalog", () => {
    const result = resolveCommand(catalog, parseSlashInput("/quit"), {
      surface: "tui",
    });

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

  it("returns AMBIGUOUS_COMMAND when multiple visible commands match the same input", () => {
    const ambiguousCatalog: UiCommandCatalog = {
      version: "ambiguous",
      commands: [
        {
          aliases: [],
          argumentMode: "argv",
          category: "project",
          description: "Open a project",
          id: "project.open",
          path: ["project", "open"],
          source: "builtin",
          surfaces: ["tui"],
        },
        {
          aliases: [["project", "open"]],
          argumentMode: "argv",
          category: "workspace",
          description: "Open a workspace",
          id: "workspace.open",
          path: ["workspace", "open"],
          source: "plugin",
          surfaces: ["tui"],
        },
      ],
    };

    expect(
      resolveCommand(ambiguousCatalog, parseSlashInput("/project open"), {
        surface: "tui",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "AMBIGUOUS_COMMAND",
        message: 'Ambiguous command "/project open"',
      },
    });
  });

  it("does not treat the same command matching through path and alias as ambiguous", () => {
    const selfAliasCatalog: UiCommandCatalog = {
      version: "self-alias",
      commands: [
        {
          aliases: [["exit"]],
          argumentMode: "argv",
          category: "system",
          description: "Exit",
          id: "exit",
          path: ["exit"],
          source: "builtin",
          surfaces: ["tui"],
        },
      ],
    };

    expect(
      resolveCommand(selfAliasCatalog, parseSlashInput("/exit"), {
        surface: "tui",
      }),
    ).toMatchObject({
      ok: true,
      command: { id: "exit" },
      path: ["exit"],
    });
  });

  it("resolves only the public sessions and resume command paths", () => {
    const sessionsResult = resolveCommand(
      catalog,
      parseSlashInput("/sessions"),
    );
    expect(sessionsResult).toMatchObject({
      ok: true,
      command: { id: "sessions" },
      path: ["sessions"],
    });

    const resumeResult = resolveCommand(
      catalog,
      parseSlashInput("/resume session_1"),
    );
    expect(resumeResult).toMatchObject({
      ok: true,
      argv: ["session_1"],
      command: { id: "resume" },
      path: ["resume"],
      rawArgs: "session_1",
    });

    expect(
      resolveCommand(catalog, parseSlashInput("/session list")),
    ).toMatchObject({
      error: { code: "COMMAND_NOT_FOUND" },
      ok: false,
    });
    expect(
      resolveCommand(catalog, parseSlashInput("/session resume session_1")),
    ).toMatchObject({
      error: { code: "COMMAND_NOT_FOUND" },
      ok: false,
    });
  });

  it("resolves multi-segment command paths and keeps only remaining argv", () => {
    expect(
      resolveCommand(
        catalog,
        parseSlashInput('/project open "D:/Projects/Example"'),
        { surface: "tui" },
      ),
    ).toMatchObject({
      ok: true,
      argv: ["D:/Projects/Example"],
      command: { id: "project.open" },
      path: ["project", "open"],
      rawArgs: '"D:/Projects/Example"',
    });
  });

  it("does not resolve permission levels as slash subcommands", () => {
    for (const input of [
      "/permission default",
      "/permission full-access",
      "/permission plan",
      "/permission auto",
      "/mode",
    ]) {
      expect(resolveCommand(catalog, parseSlashInput(input))).toEqual({
        ok: false,
        error: {
          code: "COMMAND_NOT_FOUND",
          message: `Unknown command "${input}"`,
        },
      });
    }
  });
});

describe("filterCommandCatalog", () => {
  it("filters by surface and partial slash input", () => {
    expect(filterCommandCatalog(catalog, "/mo", { surface: "tui" })).toEqual([
      expect.objectContaining({ id: "models" }),
    ]);
    expect(
      filterCommandCatalog(catalog, "/models-headless", { surface: "tui" }),
    ).toEqual([]);
  });

  it("can match aliases for completion", () => {
    expect(filterCommandCatalog(catalog, "/qu", { surface: "tui" })).toEqual([
      expect.objectContaining({ id: "exit" }),
    ]);
  });

  it("filters sessions and resume without exposing removed session subcommands", () => {
    expect(filterCommandCatalog(catalog, "/ses", { surface: "tui" })).toEqual([
      expect.objectContaining({ id: "sessions" }),
    ]);
    expect(filterCommandCatalog(catalog, "/res", { surface: "tui" })).toEqual([
      expect.objectContaining({ id: "resume" }),
    ]);
    expect(
      filterCommandCatalog(catalog, "/session r", { surface: "tui" }),
    ).toEqual([]);
  });

  it("filters nested command paths with space-separated slash input", () => {
    expect(
      filterCommandCatalog(catalog, "/project o", { surface: "tui" }),
    ).toEqual([expect.objectContaining({ id: "project.open" })]);
    expect(
      filterCommandCatalog(catalog, "/project l", { surface: "tui" }),
    ).toEqual([expect.objectContaining({ id: "project.open" })]);
  });
});
