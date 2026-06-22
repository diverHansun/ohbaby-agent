import { describe, expect, it } from "vitest";
import type { UiSlashCommandCatalog } from "ohbaby-sdk";
import type { CommandNotice } from "../api/daemon/wire.js";
import {
  createCommandResultModel,
  createSlashPaletteItems,
  safeHelpCommands,
  selectedSlashItem,
  slashCompletionSuffix,
} from "./slashCommands.js";

function commandCatalog(): UiSlashCommandCatalog {
  return {
    commands: [
      {
        argumentMode: "argv",
        category: "system",
        description: "Show backend status",
        id: "status",
        path: ["status"],
        source: "builtin",
        surfaces: ["tui"],
      },
      {
        argumentMode: "argv",
        category: "skill",
        description: "List available skills",
        id: "skills",
        path: ["skills"],
        source: "builtin",
        surfaces: ["tui"],
      },
      {
        argumentMode: "argv",
        category: "session",
        description: "Create a new session",
        id: "new",
        path: ["new"],
        source: "builtin",
        surfaces: ["tui"],
      },
      {
        argumentMode: "argv",
        category: "session",
        description: "Compact current session",
        id: "compact",
        path: ["compact"],
        source: "builtin",
        surfaces: ["tui"],
      },
    ],
    version: "commands-v1",
  };
}

describe("ohbaby-web slash commands UI helpers", () => {
  it("builds palette rows only from web-safe slash commands", () => {
    const items = createSlashPaletteItems(commandCatalog(), "/");

    expect(items.map((item) => item.label)).toEqual([
      "/new",
      "/skills",
      "/status",
    ]);
    expect(items.map((item) => item.label)).not.toContain("/compact");
    expect(items[0]).toMatchObject({
      categoryLabel: "Session",
      showCategory: true,
    });
    expect(items[1]).toMatchObject({
      categoryLabel: "Tools",
      showCategory: true,
    });
  });

  it("selects and completes the active slash command", () => {
    const items = createSlashPaletteItems(commandCatalog(), "/sta");
    const selected = selectedSlashItem(items, 10);

    expect(selected?.label).toBe("/status");
    expect(slashCompletionSuffix(selected, "/sta")).toBe("tus");
  });

  it("creates result modal models only for read-only command outputs", () => {
    const statusNotice: CommandNotice = {
      commandId: "status",
      createdAt: "2026-06-12T00:00:00.000Z",
      id: "command_status",
      kind: "success",
      output: { data: {}, kind: "data", subject: "status" },
      path: ["status"],
      text: "status",
    };
    const newNotice: CommandNotice = {
      commandId: "new",
      createdAt: "2026-06-12T00:00:00.000Z",
      id: "command_new",
      kind: "success",
      output: { data: {}, kind: "data", subject: "session.created" },
      path: ["new"],
      text: "new session",
    };

    expect(createCommandResultModel(statusNotice)).toMatchObject({
      commandLabel: "/status",
      title: "Status",
      variant: "status",
    });
    expect(createCommandResultModel(newNotice)).toBeNull();
  });

  it("filters help output down to web-safe commands", () => {
    expect(
      safeHelpCommands({
        commands: [
          { description: "Show status", id: "status", path: ["status"] },
          { description: "Compact", id: "compact", path: ["compact"] },
          { description: "Connect", id: "connect", path: ["connect"] },
        ],
      }).map((command) => command.id),
    ).toEqual(["status"]);
  });
});
