import { describe, expect, it } from "vitest";
import type {
  UiSlashCommandCatalog,
  UiSlashCommandInvocation,
} from "../index.js";
import {
  filterWebCommandCatalog,
  filterWebPassthroughCommandCatalog,
  isWebPassthroughCommandId,
  supportsWebOverlayCommandInvocation,
  supportsWebSkillCommandInvocation,
  supportsWebPassthroughCommandInvocation,
  WEB_PASSTHROUGH_COMMAND_IDS,
  WEB_OVERLAY_COMMAND_IDS,
} from "../index.js";

const catalog: UiSlashCommandCatalog = {
  commands: [
    {
      argumentMode: "argv",
      category: "system",
      description: "Show backend status",
      id: "status",
      path: ["status"],
      source: "builtin",
      surfaces: ["tui", "headless"],
    },
    {
      argumentMode: "argv",
      category: "session",
      description: "Start a new session",
      id: "new",
      path: ["new"],
      source: "builtin",
      surfaces: ["tui"],
    },
    {
      argumentMode: "argv",
      category: "session",
      description: "Browse sessions",
      id: "sessions",
      parentBehavior: "interaction",
      path: ["sessions"],
      source: "builtin",
      surfaces: ["tui"],
    },
    {
      argumentMode: "argv",
      category: "session",
      description: "Compact session",
      id: "compact",
      path: ["compact"],
      source: "builtin",
      surfaces: ["tui"],
    },
    {
      acceptsArguments: true,
      argumentMode: "argv",
      category: "session",
      description: "Create and control a long-running goal",
      id: "goal",
      path: ["goal"],
      source: "builtin",
      surfaces: ["tui"],
    },
    {
      argumentMode: "structured",
      category: "setup",
      description: "Connect model",
      id: "connect",
      parentBehavior: "interaction",
      path: ["connect"],
      source: "builtin",
      surfaces: ["tui"],
    },
    {
      argumentMode: "structured",
      category: "setup",
      description: "Connect search",
      id: "connect-search",
      parentBehavior: "interaction",
      path: ["connect-search"],
      source: "builtin",
      surfaces: ["tui"],
    },
    {
      acceptsArguments: true,
      argumentMode: "raw",
      category: "skill",
      description: "Use Hansun knowledge base",
      id: "skill.hansun-db",
      path: ["hansun-db"],
      source: "skill",
      surfaces: ["tui", "headless"],
    },
    {
      argumentMode: "argv",
      category: "system",
      description: "Exit",
      id: "exit",
      path: ["exit"],
      source: "builtin",
      surfaces: ["tui"],
    },
  ],
  version: "commands-v1",
};

function invocation(
  commandId: string,
  path: readonly string[],
): UiSlashCommandInvocation {
  return {
    argv: [],
    clientInvocationId: `invoke_${commandId}`,
    commandId,
    path,
    raw: `/${path.join(" ")}`,
    rawArgs: "",
    surface: "tui",
  };
}

describe("web slash passthrough helpers", () => {
  it("defines the current web-safe allowlist", () => {
    expect(WEB_PASSTHROUGH_COMMAND_IDS).toEqual([
      "help",
      "mcps",
      "skills",
      "status",
    ]);
    expect(isWebPassthroughCommandId("status")).toBe(true);
    expect(isWebPassthroughCommandId("new")).toBe(false);
    expect(isWebPassthroughCommandId("sessions")).toBe(false);
  });

  it("defines structured overlay commands separately from passthrough", () => {
    expect(WEB_OVERLAY_COMMAND_IDS).toEqual([
      "connect",
      "connect-search",
      "compact",
      "goal",
    ]);
    expect(WEB_PASSTHROUGH_COMMAND_IDS).not.toContain("connect");
    expect(WEB_PASSTHROUGH_COMMAND_IDS).not.toContain("connect-search");
    expect(WEB_PASSTHROUGH_COMMAND_IDS).not.toContain("compact");
    expect(WEB_PASSTHROUGH_COMMAND_IDS).not.toContain("goal");
  });

  it("filters catalogs by allowlist, surface, and interaction behavior", () => {
    expect(
      filterWebPassthroughCommandCatalog(catalog, { surface: "tui" }).commands,
    ).toEqual([expect.objectContaining({ id: "status" })]);
    expect(
      filterWebPassthroughCommandCatalog(catalog, {
        surface: "headless",
      }).commands,
    ).toEqual([expect.objectContaining({ id: "status" })]);
  });

  it("requires web commands to be builtin commands at their canonical paths", () => {
    const spoofedCatalog: UiSlashCommandCatalog = {
      commands: [
        {
          argumentMode: "argv",
          category: "system",
          description: "Spoofed status",
          id: "status",
          path: ["status"],
          source: "plugin",
          surfaces: ["tui"],
        },
        {
          argumentMode: "argv",
          category: "system",
          description: "Wrong builtin status path",
          id: "status",
          path: ["status-alt"],
          source: "builtin",
          surfaces: ["tui"],
        },
        {
          argumentMode: "structured",
          category: "setup",
          description: "Spoofed connect",
          id: "connect",
          path: ["connect"],
          source: "plugin",
          surfaces: ["tui"],
        },
        {
          argumentMode: "argv",
          category: "session",
          description: "Wrong builtin compact path",
          id: "compact",
          path: ["compact-alt"],
          source: "builtin",
          surfaces: ["tui"],
        },
      ],
      version: "commands-v1",
    };

    expect(
      filterWebPassthroughCommandCatalog(spoofedCatalog, {
        surface: "tui",
      }).commands,
    ).toEqual([]);
    expect(
      filterWebCommandCatalog(spoofedCatalog, { surface: "tui" }).commands,
    ).toEqual([]);
    expect(
      supportsWebPassthroughCommandInvocation(
        spoofedCatalog,
        invocation("status", ["status"]),
      ),
    ).toBe(false);
  });

  it("validates hand-written invocations against the same web-safe catalog rules", () => {
    expect(
      supportsWebPassthroughCommandInvocation(
        catalog,
        invocation("status", ["status"]),
      ),
    ).toBe(true);
    expect(
      supportsWebPassthroughCommandInvocation(
        catalog,
        invocation("new", ["new"]),
      ),
    ).toBe(false);
    expect(
      supportsWebPassthroughCommandInvocation(
        catalog,
        invocation("sessions", ["sessions"]),
      ),
    ).toBe(false);
    expect(
      supportsWebPassthroughCommandInvocation(
        catalog,
        invocation("compact", ["compact"]),
      ),
    ).toBe(false);
    expect(
      supportsWebPassthroughCommandInvocation(
        catalog,
        invocation("goal", ["goal"]),
      ),
    ).toBe(false);
    expect(
      supportsWebPassthroughCommandInvocation(
        catalog,
        invocation("status", ["status", "extra"]),
      ),
    ).toBe(false);
  });

  it("builds a web command palette with passthrough and overlay entries", () => {
    expect(filterWebCommandCatalog(catalog, { surface: "tui" })).toEqual({
      commands: [
        expect.objectContaining({
          action: "executeCommand",
          executionKind: "passthrough",
          id: "status",
        }),
        expect.objectContaining({
          action: "compactSession",
          executionKind: "overlay",
          id: "compact",
        }),
        expect.objectContaining({
          action: "openGoalPanel",
          executionKind: "overlay",
          id: "goal",
        }),
        expect.objectContaining({
          action: "connectModel",
          executionKind: "overlay",
          id: "connect",
        }),
        expect.objectContaining({
          action: "connectSearch",
          executionKind: "overlay",
          id: "connect-search",
        }),
        expect.objectContaining({
          action: "executeCommand",
          executionKind: "skill",
          id: "skill.hansun-db",
          path: ["hansun-db"],
        }),
      ],
      version: "commands-v1",
    });
  });

  it("validates web overlay invocations against id, path, and surface", () => {
    expect(
      supportsWebOverlayCommandInvocation(
        catalog,
        invocation("goal", ["goal"]),
      ),
    ).toBe(true);
    expect(
      supportsWebOverlayCommandInvocation(
        catalog,
        invocation("compact", ["compact"]),
      ),
    ).toBe(false);
    expect(
      supportsWebOverlayCommandInvocation(
        catalog,
        invocation("status", ["status"]),
      ),
    ).toBe(false);
    expect(
      supportsWebOverlayCommandInvocation(
        catalog,
        invocation("goal", ["goal", "extra"]),
      ),
    ).toBe(false);
    expect(
      supportsWebOverlayCommandInvocation(catalog, {
        ...invocation("goal", ["goal"]),
        surface: "remote",
      }),
    ).toBe(false);
  });

  it("keeps skill commands out of the passthrough allowlist", () => {
    expect(
      filterWebPassthroughCommandCatalog(catalog, { surface: "tui" }).commands,
    ).not.toContainEqual(expect.objectContaining({ id: "skill.hansun-db" }));
  });

  it("validates web skill invocations against source, path, and surface", () => {
    expect(
      supportsWebSkillCommandInvocation(
        catalog,
        invocation("skill.hansun-db", ["hansun-db"]),
      ),
    ).toBe(true);
    expect(
      supportsWebSkillCommandInvocation(
        catalog,
        invocation("skill.hansun-db", ["hansun-db", "extra"]),
      ),
    ).toBe(false);
    expect(
      supportsWebSkillCommandInvocation(
        catalog,
        invocation("hansun-db", ["hansun-db"]),
      ),
    ).toBe(false);
    expect(
      supportsWebSkillCommandInvocation(catalog, {
        ...invocation("skill.hansun-db", ["hansun-db"]),
        surface: "remote",
      }),
    ).toBe(false);
  });

  it("rejects skill-looking commands that are not user-invocable skill specs", () => {
    const invalidSkillCatalog: UiSlashCommandCatalog = {
      commands: [
        {
          argumentMode: "raw",
          category: "skill",
          description: "Plugin pretending to be a skill",
          id: "plugin.hansun-db",
          path: ["plugin-hansun-db"],
          source: "plugin",
          surfaces: ["tui"],
        },
        {
          argumentMode: "argv",
          category: "skill",
          description: "Skill with wrong argument mode",
          id: "skill.argv-skill",
          path: ["argv-skill"],
          source: "skill",
          surfaces: ["tui"],
        },
        {
          acceptsArguments: true,
          argumentMode: "raw",
          category: "skill",
          description: "Nested skill path",
          id: "skill.nested",
          path: ["nested", "skill"],
          source: "skill",
          surfaces: ["tui"],
        },
      ],
      version: "commands-v1",
    };

    expect(
      filterWebCommandCatalog(invalidSkillCatalog, { surface: "tui" }).commands,
    ).toEqual([]);
    expect(
      supportsWebSkillCommandInvocation(
        invalidSkillCatalog,
        invocation("plugin.hansun-db", ["plugin-hansun-db"]),
      ),
    ).toBe(false);
    expect(
      supportsWebSkillCommandInvocation(
        invalidSkillCatalog,
        invocation("skill.argv-skill", ["argv-skill"]),
      ),
    ).toBe(false);
    expect(
      supportsWebSkillCommandInvocation(
        invalidSkillCatalog,
        invocation("skill.nested", ["nested", "skill"]),
      ),
    ).toBe(false);
  });
});
