import { describe, expect, it } from "vitest";
import type { UiWebCommandCatalog } from "ohbaby-sdk";
import type { CommandNotice } from "../api/daemon/wire.js";
import type { HeaderModel, ViewModel } from "./selectors.js";
import {
  createCommandResultModel,
  createSlashPaletteItems,
  safeHelpCommands,
  selectedSlashItem,
  slashCompletionSuffix,
  statusContextWindowUsage,
  statusPromptCacheUsage,
  statusRows,
} from "./slashCommands.js";

function commandCatalog(): UiWebCommandCatalog {
  return {
    commands: [
      {
        action: "executeCommand",
        argumentMode: "argv",
        category: "system",
        description: "Show backend status",
        executionKind: "passthrough",
        id: "status",
        path: ["status"],
        source: "builtin",
        surfaces: ["tui"],
      },
      {
        action: "executeCommand",
        argumentMode: "argv",
        category: "session",
        description: "Create a new session",
        executionKind: "passthrough",
        id: "new",
        path: ["new"],
        source: "builtin",
        surfaces: ["tui"],
      },
      {
        action: "executeCommand",
        aliases: [["skill"]],
        argumentMode: "argv",
        category: "skill",
        description: "List available skills",
        executionKind: "passthrough",
        id: "skills",
        path: ["skills"],
        source: "builtin",
        surfaces: ["tui"],
      },
      {
        acceptsArguments: true,
        action: "executeCommand",
        argumentMode: "raw",
        category: "skill",
        description: "Use Hansun knowledge base",
        executionKind: "skill",
        id: "skill.hansun-db",
        path: ["hansun-db"],
        source: "skill",
        surfaces: ["tui"],
      },
      {
        action: "compactSession",
        argumentMode: "argv",
        category: "session",
        description: "Compact current session",
        executionKind: "overlay",
        id: "compact",
        path: ["compact"],
        source: "builtin",
        surfaces: ["tui"],
      },
      {
        action: "connectModel",
        argumentMode: "argv",
        category: "model",
        description: "Connect to an LLM provider",
        executionKind: "overlay",
        id: "connect",
        path: ["connect"],
        source: "builtin",
        surfaces: ["tui"],
      },
      {
        action: "connectSearch",
        argumentMode: "argv",
        category: "tool",
        description: "Connect a web search provider",
        executionKind: "overlay",
        id: "connect-search",
        path: ["connect-search"],
        source: "builtin",
        surfaces: ["tui"],
      },
    ],
    version: "commands-v1",
  };
}

function statusModels(): {
  readonly header: HeaderModel;
  readonly view: ViewModel;
} {
  const header: HeaderModel = {
    connectionKind: "idle",
    contextLabel: "38k / 100k",
    contextRatio: 0.38,
    contextWindowUsage: null,
    modelLabel: "model-a",
    statusLabel: "Idle",
  };
  return {
    header,
    view: {
      activeGoal: null,
      activeSession: null,
      activeTodoList: null,
      commandCatalogVersion: null,
      commandNotices: [],
      composer: {
        canSend: true,
        canStop: false,
        disabled: false,
        hint: "",
        isRunning: false,
        mode: "auto",
        permissionLevel: "default",
      },
      error: null,
      header,
      isEmpty: true,
      pendingPermissions: [],
      queuedPrompts: [],
      reasoningByMessageId: {},
      snapshot: null,
    },
  };
}

describe("ohbaby-web slash commands UI helpers", () => {
  it("builds palette rows from web-safe passthrough and overlay commands", () => {
    const items = createSlashPaletteItems(commandCatalog(), "/");

    expect(items.map((item) => item.label)).toEqual([
      "/connect",
      "/connect-search",
      "/compact",
      "/skills",
      "/status",
    ]);
    expect(items.map((item) => item.label)).not.toContain("/hansun-db");
    expect(items.map((item) => item.label)).not.toContain("/new");
    expect(items[0]).toMatchObject({
      categoryLabel: "Setup",
      executionKind: "overlay",
      showCategory: true,
    });
    expect(items[2]).toMatchObject({
      categoryLabel: "Session",
      executionKind: "overlay",
      showCategory: true,
    });
    expect(items[3]).toMatchObject({
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

  it("keeps the /skill input alias canonical in palette labels", () => {
    const items = createSlashPaletteItems(commandCatalog(), "/skill");

    expect(items.map((item) => item.label)).toEqual(["/skills"]);
    expect(slashCompletionSuffix(items[0], "/skill")).toBe("s");
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

  it("uses the canonical notice path for the /skills result header", () => {
    const notice: CommandNotice = {
      commandId: "skills",
      createdAt: "2026-09-01T00:00:00.000Z",
      id: "command_skills_alias",
      kind: "success",
      output: { data: { skills: [] }, kind: "data", subject: "skills" },
      path: ["skills"],
      text: "skills",
    };

    expect(createCommandResultModel(notice)).toMatchObject({
      commandLabel: "/skills",
      variant: "skills",
    });
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

  it("reads optional seven-bucket context composition from status output", () => {
    const usage = statusContextWindowUsage({
      contextWindow: {
        composition: {
          "system-prompt": 10,
          "builtin-tools": 20,
          mcp: 30,
          skills: 40,
          conversation: 50,
          "summarized-conversation": 60,
          "subagent-exchanges": 0,
        },
        contextWindowRatio: 0.21,
        contextWindowTokens: 1_000,
        currentTokens: 210,
        estimatedAt: "2026-08-27T00:00:00.000Z",
        modelId: "model-a",
        sessionId: "session_1",
      },
    });

    expect(usage).toMatchObject({
      composition: {
        "system-prompt": 10,
        "subagent-exchanges": 0,
      },
      currentTokens: 210,
      sessionId: "session_1",
    });
  });

  it("keeps valid status totals but drops malformed composition", () => {
    const usage = statusContextWindowUsage({
      contextWindow: {
        composition: {
          "system-prompt": 10,
          "builtin-tools": 20,
          mcp: 30,
          skills: 40,
          conversation: 50.5,
          "summarized-conversation": 60,
          "subagent-exchanges": 0,
        },
        contextWindowRatio: 0.21,
        contextWindowTokens: 1_000,
        currentTokens: 210,
        estimatedAt: "2026-08-27T00:00:00.000Z",
        modelId: "model-a",
        sessionId: "session_1",
      },
    });

    expect(usage).not.toBeNull();
    expect(usage).not.toHaveProperty("composition");
  });

  it("inserts a cache row after context with rounded session share", () => {
    const { header, view } = statusModels();
    const rows = statusRows(
      {
        promptCacheUsage: {
          accountedInputTokens: 10_000,
          cacheReadShare: 0.614,
          cacheReadTokens: 6_140,
          sessionId: "session_1",
        },
      },
      header,
      view,
    );

    expect(rows.find((row) => row.label === "cache")).toEqual({
      label: "cache",
      value: "hit 61%",
    });
    expect(rows.map((row) => row.label).slice(1, 5)).toEqual([
      "model",
      "context",
      "cache",
      "connection",
    ]);
  });

  it.each([
    {
      expectedShare: null,
      expectedValue: "hit —",
      input: {
        accountedInputTokens: 0,
        cacheReadShare: null,
        cacheReadTokens: 0,
        sessionId: "session_1",
      },
    },
    {
      expectedShare: 0,
      expectedValue: "hit 0%",
      input: {
        accountedInputTokens: 100,
        cacheReadShare: 0,
        cacheReadTokens: 0,
        sessionId: "session_1",
      },
    },
  ])(
    "accepts cache usage state $expectedShare",
    ({ expectedShare, expectedValue, input }) => {
      const data = { promptCacheUsage: input };
      const { header, view } = statusModels();
      expect(statusPromptCacheUsage(data)?.cacheReadShare).toBe(expectedShare);
      expect(statusRows(data, header, view)).toContainEqual({
        label: "cache",
        value: expectedValue,
      });
    },
  );

  it.each([
    {},
    { promptCacheUsage: null },
    {
      promptCacheUsage: {
        accountedInputTokens: 100,
        cacheReadShare: 0.5,
        cacheReadTokens: 101,
        sessionId: "session_1",
      },
    },
    {
      promptCacheUsage: {
        accountedInputTokens: 100,
        cacheReadShare: Number.NaN,
        cacheReadTokens: 50,
        sessionId: "session_1",
      },
    },
    {
      promptCacheUsage: {
        accountedInputTokens: 100,
        cacheReadShare: 1.1,
        cacheReadTokens: 50,
        sessionId: "session_1",
      },
    },
    {
      promptCacheUsage: {
        accountedInputTokens: 0,
        cacheReadShare: 0,
        cacheReadTokens: 0,
        sessionId: "session_1",
      },
    },
    {
      promptCacheUsage: {
        accountedInputTokens: 100,
        cacheReadShare: 0.5,
        cacheReadTokens: 50,
        sessionId: "",
      },
    },
  ])("fails closed for absent or malformed cache usage", (data) => {
    const { header, view } = statusModels();
    expect(statusPromptCacheUsage(data)).toBeNull();
    expect(
      statusRows(data, header, view).map((row) => row.label),
    ).not.toContain("cache");
  });
});
