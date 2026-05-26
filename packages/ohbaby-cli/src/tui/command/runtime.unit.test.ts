import { describe, expect, it } from "vitest";
import type { TuiCommandCatalog } from "../store/snapshot.js";
import {
  applySlashCompletion,
  filterCommandCatalog,
  parseSlashInput,
  resolveCommand,
} from "./runtime.js";

const catalog: TuiCommandCatalog = {
  commands: [
    {
      description: "Select or switch model",
      id: "model",
      path: ["model"],
      surfaces: ["tui"],
    },
    {
      acceptsArguments: true,
      description: "Open model switcher",
      id: "model.switch",
      path: ["model", "switch"],
      surfaces: ["tui"],
    },
    {
      acceptsArguments: true,
      description: "Resume a session",
      id: "session.resume",
      aliases: [],
      path: ["resume"],
      surfaces: ["tui"],
    },
    {
      description: "Choose a session",
      id: "session",
      path: ["session"],
      surfaces: ["tui"],
    },
    {
      description: "Show policy mode",
      id: "mode",
      path: ["mode"],
      surfaces: ["tui"],
    },
    {
      description: "Switch to ask mode",
      id: "mode.ask",
      path: ["mode", "ask"],
      surfaces: ["tui"],
    },
  ],
  loadedAt: 1_771_000_000_000,
  surface: "tui",
  version: "v1",
};

describe("slash command runtime", () => {
  it("parses slash input into command path and argv", () => {
    const parsed = parseSlashInput('/model switch "gpt-5.5" --reason fast');

    expect(parsed).toMatchObject({
      argv: ["gpt-5.5", "--reason", "fast"],
      path: ["model", "switch"],
      rawArgs: '"gpt-5.5" --reason fast',
      rawPath: "model switch",
    });
  });

  it("resolves only exact command matches", () => {
    const parsed = parseSlashInput("/model switch gpt-5.5");
    const result = resolveCommand(parsed, catalog, {
      sessionId: "session_1",
      surface: "tui",
    });

    expect(result.kind).toBe("resolved");
    expect(result.kind === "resolved" ? result.invocation.commandId : "").toBe(
      "model.switch",
    );
  });

  it("builds invocation args from matched tokens instead of raw spacing", () => {
    const parsed = parseSlashInput('/model   switch   "gpt-5.5 beta"');
    const result = resolveCommand(parsed, catalog, { surface: "tui" });

    expect(result.kind).toBe("resolved");
    expect(result.kind === "resolved" ? result.invocation.rawArgs : "").toBe(
      '"gpt-5.5 beta"',
    );
    expect(result.kind === "resolved" ? result.invocation.argv : []).toEqual([
      "gpt-5.5 beta",
    ]);
  });

  it("resolves the top-level resume command with its argument span", () => {
    const parsed = parseSlashInput('/resume   "session 1"');
    const result = resolveCommand(parsed, catalog, { surface: "tui" });

    expect(result.kind).toBe("resolved");
    expect(result.kind === "resolved" ? result.invocation.commandId : "").toBe(
      "session.resume",
    );
    expect(result.kind === "resolved" ? result.invocation.argv : []).toEqual([
      "session 1",
    ]);
    expect(result.kind === "resolved" ? result.invocation.rawArgs : "").toBe(
      '"session 1"',
    );
  });

  it("does not infer /model gpt-5.5 as /model switch", () => {
    const parsed = parseSlashInput("/model gpt-5.5");
    const result = resolveCommand(parsed, catalog, { surface: "tui" });

    expect(result).toMatchObject({
      kind: "not-found",
      reason: "No exact command match",
    });
  });

  it("filters command catalog for slash hints", () => {
    const parsed = parseSlashInput("/ses");
    const matches = filterCommandCatalog(parsed, catalog, { surface: "tui" });

    expect(matches.map((command) => command.id)).toEqual(["session"]);
  });

  it("does not resolve removed session subcommands", () => {
    expect(resolveCommand(parseSlashInput("/session list"), catalog, {
      surface: "tui",
    })).toMatchObject({
      kind: "not-found",
    });
    expect(resolveCommand(parseSlashInput("/session resume session_1"), catalog, {
      surface: "tui",
    })).toMatchObject({
      kind: "not-found",
    });
  });

  it("orders exact slash command hints before shared-prefix commands", () => {
    const parsed = parseSlashInput("/mode");
    const matches = filterCommandCatalog(parsed, catalog, { surface: "tui" });

    expect(matches.map((command) => command.id).slice(0, 3)).toEqual([
      "mode",
      "mode.ask",
      "model",
    ]);
  });

  it("applies tab completion without resolving or executing", () => {
    const completed = applySlashCompletion("/res", catalog, { surface: "tui" });

    expect(completed).toEqual("/resume ");
  });
});
