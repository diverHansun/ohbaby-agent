import { describe, expect, it } from "vitest";
import type {
  UiSlashCommandCatalog,
  UiSlashCommandInvocation,
} from "../index.js";
import {
  filterWebPassthroughCommandCatalog,
  isWebPassthroughCommandId,
  supportsWebPassthroughCommandInvocation,
  WEB_PASSTHROUGH_COMMAND_IDS,
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
  it("defines the v0.1.6 web-safe allowlist", () => {
    expect(WEB_PASSTHROUGH_COMMAND_IDS).toEqual([
      "help",
      "mcps",
      "new",
      "skills",
      "status",
    ]);
    expect(isWebPassthroughCommandId("status")).toBe(true);
    expect(isWebPassthroughCommandId("sessions")).toBe(false);
  });

  it("filters catalogs by allowlist, surface, and interaction behavior", () => {
    expect(
      filterWebPassthroughCommandCatalog(catalog, { surface: "tui" }).commands,
    ).toEqual([
      expect.objectContaining({ id: "status" }),
      expect.objectContaining({ id: "new" }),
    ]);
    expect(
      filterWebPassthroughCommandCatalog(catalog, {
        surface: "headless",
      }).commands,
    ).toEqual([expect.objectContaining({ id: "status" })]);
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
        invocation("status", ["status", "extra"]),
      ),
    ).toBe(false);
  });
});
