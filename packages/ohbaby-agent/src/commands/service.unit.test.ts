import { describe, expect, it, vi } from "vitest";
import type {
  UiCommandInvocation,
  UiInteractionResponse,
  UiSnapshot,
} from "ohbaby-sdk";
import type { CommandMcpProvider, CommandSkillProvider } from "./types.js";
import { createBus } from "../bus/index.js";
import { CommandsEvent, createCommandService } from "./index.js";
import { createInteractionBroker } from "../runtime/interaction-broker/index.js";

type UiPermissionState = NonNullable<UiSnapshot["permission"]>;

describe("CommandService", () => {
  it("lists permission commands in the builtin catalog", async () => {
    const { service } = createServiceHarness();

    const catalog = await service.listCommands({ surface: "tui" });

    expect(catalog.commands.map((command) => command.id)).toEqual(
      expect.arrayContaining(["permission"]),
    );
    expect(catalog.commands.map((command) => command.id)).not.toEqual(
      expect.arrayContaining([
        "mode",
        "permission.default",
        "permission.full-access",
      ]),
    );
  });

  it("executes status and publishes command events with model context", async () => {
    const { events, service } = createServiceHarness({
      models: {
        currentModel() {
          return {
            apiKeyEnv: "OPENAI_API_KEY",
            baseUrl: "https://api.openai.com/v1",
            id: "openai:gpt-5.5",
            label: "GPT-5.5",
            model: "gpt-5.5",
            provider: "openai",
          };
        },
        listModels() {
          return [
            {
              apiKeyEnv: "OPENAI_API_KEY",
              baseUrl: "https://api.openai.com/v1",
              id: "openai:gpt-5.5",
              label: "GPT-5.5",
              model: "gpt-5.5",
              provider: "openai",
            },
          ];
        },
      },
    });

    await service.executeCommand(makeInvocation("status", ["status"]));

    const startedEvent = events.find(
      (event) => event.type === "started" && event.commandId === "status",
    );
    expect(startedEvent).toMatchObject({
      commandId: "status",
      commandRunId: "command_1",
      type: "started",
    });

    expect(dataOutputBySubject(events, "status")).toMatchObject({
      data: {
        model: {
          apiKeyEnv: "OPENAI_API_KEY",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5.5",
          provider: "openai",
        },
        models: [
          {
            model: "gpt-5.5",
            provider: "openai",
          },
        ],
        status: "idle",
      },
      kind: "data",
      subject: "status",
    });
  });

  it("emits help for the active command catalog", async () => {
    const { events, service } = createServiceHarness();

    await service.executeCommand(makeInvocation("help", ["help"]));

    const helpEvent = events.at(-1);
    expect(helpEvent).toMatchObject({
      output: {
        kind: "data",
        subject: "help",
      },
      type: "result",
    });
    const output = isRecord(helpEvent?.output) ? helpEvent.output : undefined;
    const data = output ? getRecord(output, "data") : undefined;
    const commands = data ? getArray(data, "commands") : [];
    const categories = data ? getArray(data, "categories") : [];
    expect(
      commands.map((command) =>
        isRecord(command) && typeof command.id === "string" ? command.id : "",
      ),
    ).toEqual(expect.arrayContaining(["models", "permission"]));
    expect(
      categories.map((category) =>
        isRecord(category) ? category.name : undefined,
      ),
    ).toEqual(expect.arrayContaining(["system", "model", "permission"]));
    expect(
      categories.flatMap((category): readonly unknown[] =>
        isRecord(category) ? getArray(category, "commands") : [],
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "models" }),
        expect.objectContaining({ id: "permission" }),
      ]),
    );
  });

  it("emits help categories including dynamic skill commands", async () => {
    const { events, service } = createServiceHarness({
      skills: {
        listUserInvocable() {
          return [
            {
              description: "Review code",
              name: "review",
              scope: "project",
              source: "project-native",
            },
          ];
        },
        loadPrompt() {
          return "";
        },
      },
    });

    await service.executeCommand(makeInvocation("help", ["help"]));

    const output = dataOutputFrom(events.at(-1));
    expect(output?.subject).toBe("help");
    expect(output?.data.commands).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "skill.review" })]),
    );
    const categories = output ? getArray(output.data, "categories") : [];
    const skillCategory = categories.find(
      (category) => isRecord(category) && category.name === "skill",
    );
    const skillCommands = isRecord(skillCategory)
      ? getArray(skillCategory, "commands")
      : [];
    expect(skillCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "skill.review", path: ["review"] }),
      ]),
    );
  });

  it("allows reclaimed external roots while protecting active reserved paths", async () => {
    const { service } = createServiceHarness({
      extraCommands: [
        {
          argumentMode: "argv",
          category: "plugin",
          description: "Legacy model command",
          id: "plugin.model",
          path: ["model"],
          source: "plugin",
          surfaces: ["tui"],
        },
        {
          argumentMode: "argv",
          category: "plugin",
          description: "Legacy abort command",
          id: "plugin.abort",
          path: ["abort"],
          source: "plugin",
          surfaces: ["tui"],
        },
        {
          argumentMode: "argv",
          category: "plugin",
          description: "Plugin tools command",
          id: "plugin.tools",
          path: ["tools"],
          source: "plugin",
          surfaces: ["tui"],
        },
        {
          argumentMode: "argv",
          category: "plugin",
          description: "Diagnostics",
          id: "diagnostics",
          path: ["diagnostics"],
          source: "plugin",
          surfaces: ["tui"],
        },
      ],
      skills: {
        listUserInvocable() {
          return [
            {
              name: "session",
              description: "Legacy session skill",
              scope: "project",
            },
            {
              name: "review",
              description: "Review code",
              scope: "project",
              source: "project-native",
            },
          ];
        },
        loadPrompt() {
          return "";
        },
      },
    });

    const catalog = await service.listCommands({ surface: "tui" });

    expect(catalog.commands.map((command) => command.id)).toEqual(
      expect.arrayContaining([
        "diagnostics",
        "plugin.abort",
        "plugin.tools",
        "skill.review",
        "skill.session",
      ]),
    );
    expect(
      catalog.commands.map((command) => command.path.join("/")),
    ).not.toEqual(expect.arrayContaining(["model"]));
  });

  it("emits MCP server summaries from the /mcps command", async () => {
    const { events, service } = createServiceHarness({
      mcps: {
        listServers() {
          return [
            { name: "github", status: "connected", toolCount: 8 },
            { error: "boom", name: "bad", status: "failed" },
            { name: "memory", status: "disabled" },
          ] as unknown as ReturnType<CommandMcpProvider["listServers"]>;
        },
      },
    });

    await service.executeCommand(makeInvocation("mcps", ["mcps"]));

    expect(dataOutputFrom(events.at(-1))).toMatchObject({
      data: {
        servers: [
          { name: "github", status: "connected" },
          { name: "bad", status: "failed" },
          { name: "memory", status: "disabled" },
        ],
      },
      kind: "data",
      subject: "mcps",
    });
  });

  it("emits an empty MCP server list when the provider fails", async () => {
    const { events, service } = createServiceHarness({
      mcps: {
        listServers() {
          throw new Error("mcp status unavailable");
        },
      },
    });

    await service.executeCommand(makeInvocation("mcps", ["mcps"]));

    expect(dataOutputFrom(events.at(-1))).toMatchObject({
      data: { servers: [] },
      kind: "data",
      subject: "mcps",
    });
  });

  it("emits an empty MCP server list when the provider is missing", async () => {
    const { events, service } = createServiceHarness();

    await service.executeCommand(makeInvocation("mcps", ["mcps"]));

    expect(dataOutputFrom(events.at(-1))).toMatchObject({
      data: { servers: [] },
      kind: "data",
      subject: "mcps",
    });
  });

  it("emits user-invocable skills from the /skills command", async () => {
    const { events, service } = createServiceHarness({
      skills: {
        listUserInvocable() {
          return [
            {
              description: "Review code",
              name: "review",
              scope: "project",
              source: "project-native",
            },
            {
              description: "Brainstorm ideas",
              name: "brainstorming",
              scope: "user",
            },
          ];
        },
        loadPrompt() {
          return "";
        },
      },
    });

    await service.executeCommand(makeInvocation("skills", ["skills"]));

    expect(dataOutputFrom(events.at(-1))).toMatchObject({
      data: {
        skills: [
          {
            commandId: "skill.review",
            description: "Review code",
            name: "review",
            path: ["review"],
            scope: "project",
            source: "project-native",
          },
          {
            commandId: "skill.brainstorming",
            description: "Brainstorm ideas",
            name: "brainstorming",
            path: ["brainstorming"],
            scope: "user",
          },
        ],
      },
      kind: "data",
      subject: "skills",
    });
  });

  it("filters skills with invalid scopes from command outputs", async () => {
    const { events, service } = createServiceHarness({
      skills: {
        listUserInvocable() {
          return [
            {
              description: "Review code",
              name: "review",
              scope: "project",
            },
            {
              description: "Invalid skill",
              name: "invalid",
              scope: "workspace",
            },
          ] as unknown as ReturnType<CommandSkillProvider["listUserInvocable"]>;
        },
        loadPrompt() {
          return "";
        },
      },
    });

    await service.executeCommand(makeInvocation("skills", ["skills"]));
    await service.executeCommand(makeInvocation("help", ["help"]));

    const outputs = events
      .map(dataOutputFrom)
      .filter((output): output is NonNullable<typeof output> =>
        Boolean(output),
      );
    const skillsOutput = outputs.find((output) => output.subject === "skills");
    const helpOutput = outputs.find((output) => output.subject === "help");

    expect(skillsOutput).toMatchObject({
      data: {
        skills: [
          expect.objectContaining({
            commandId: "skill.review",
            name: "review",
            scope: "project",
          }),
        ],
      },
      kind: "data",
      subject: "skills",
    });
    const emittedSkills = skillsOutput
      ? getArray(skillsOutput.data, "skills")
      : [];
    expect(
      emittedSkills.map((skill) =>
        isRecord(skill) ? getString(skill, "name") : undefined,
      ),
    ).toEqual(["review"]);

    const helpCommands = helpOutput
      ? getArray(helpOutput.data, "commands")
      : [];
    expect(
      helpCommands.map((command) =>
        isRecord(command) ? getString(command, "id") : undefined,
      ),
    ).not.toContain("skill.invalid");
  });

  it("emits an empty skills list when the provider is missing", async () => {
    const { events, service } = createServiceHarness();

    await service.executeCommand(makeInvocation("skills", ["skills"]));

    expect(dataOutputFrom(events.at(-1))).toMatchObject({
      data: { skills: [] },
      kind: "data",
      subject: "skills",
    });
  });

  it("aggregates extended backend status fields", async () => {
    const contextUsage = {
      contextLimit: 128_000,
      currentTokens: 9_000,
      modelId: "fake-model",
      remainingTokens: 119_000,
      shouldCompress: false,
      usageRatio: 9_000 / 128_000,
    };
    const { events, service } = createServiceHarness({
      getContextUsage() {
        return contextUsage;
      },
      getProjectRoot() {
        return "D:/Projects/app";
      },
      mcps: {
        listServers() {
          return [
            { name: "github", status: "connected", toolCount: 8 },
            { error: "boom", name: "bad", status: "failed" },
            { name: "memory", status: "disabled" },
            { name: "local", status: "disconnected" },
          ];
        },
      },
      skills: {
        listUserInvocable() {
          return [
            { description: "Review code", name: "review", scope: "project" },
            { description: "Brainstorm", name: "brainstorm", scope: "user" },
          ];
        },
        loadPrompt() {
          return "";
        },
      },
      tools: {
        listTools() {
          return [
            { description: "Shell", name: "bash", source: "builtin" },
            { description: "Task", name: "task", source: "module" },
            { description: "Skill", name: "skill", source: "skill" },
            { description: "GitHub", name: "github", source: "mcp" },
            { description: "Unknown", name: "unknown", source: "other" },
          ];
        },
      },
    });

    await service.executeCommand(makeInvocation("status", ["status"]));

    expect(dataOutputFrom(events.at(-1))).toMatchObject({
      data: {
        context: contextUsage,
        mcps: {
          connected: 1,
          disabled: 1,
          disconnected: 1,
          failed: 1,
          total: 4,
        },
        projectRoot: "D:/Projects/app",
        sessionId: "session_1",
        skillsCount: 2,
        status: "idle",
        tools: {
          builtin: 1,
          mcp: 1,
          module: 1,
          skill: 1,
        },
      },
      kind: "data",
      subject: "status",
    });
  });

  it("uses empty status aggregates when optional providers are missing", async () => {
    const { events, service } = createServiceHarness();

    await service.executeCommand(makeInvocation("status", ["status"]));

    expect(dataOutputFrom(events.at(-1))).toMatchObject({
      data: {
        context: null,
        mcps: {
          connected: 0,
          disabled: 0,
          disconnected: 0,
          failed: 0,
          total: 0,
        },
        projectRoot: null,
        sessionId: "session_1",
        skillsCount: 0,
        tools: {
          builtin: 0,
          mcp: 0,
          module: 0,
          skill: 0,
        },
      },
      kind: "data",
      subject: "status",
    });
  });

  it("uses empty MCP aggregates in /status when the MCP provider fails", async () => {
    const { events, service } = createServiceHarness({
      mcps: {
        listServers() {
          throw new Error("mcp status unavailable");
        },
      },
    });

    await service.executeCommand(makeInvocation("status", ["status"]));

    expect(dataOutputFrom(events.at(-1))).toMatchObject({
      data: {
        mcps: {
          connected: 0,
          disabled: 0,
          disconnected: 0,
          failed: 0,
          total: 0,
        },
      },
      kind: "data",
      subject: "status",
    });
  });

  it("reports configured models from the /models command", async () => {
    const { events, service } = createServiceHarness({
      models: {
        currentModel() {
          return {
            apiKeyEnv: "OPENAI_API_KEY",
            baseUrl: "https://api.openai.com/v1",
            id: "openai:gpt-5.5",
            label: "GPT-5.5",
            model: "gpt-5.5",
            provider: "openai",
          };
        },
        listModels() {
          return [
            {
              apiKeyEnv: "OPENAI_API_KEY",
              baseUrl: "https://api.openai.com/v1",
              id: "openai:gpt-5.5",
              label: "GPT-5.5",
              model: "gpt-5.5",
              provider: "openai",
            },
          ];
        },
      },
    });

    await service.executeCommand(makeInvocation("models", ["models"]));

    expect(events.at(-1)).toMatchObject({
      output: {
        data: {
          current: {
            apiKeyEnv: "OPENAI_API_KEY",
            baseUrl: "https://api.openai.com/v1",
            id: "openai:gpt-5.5",
            label: "GPT-5.5",
            model: "gpt-5.5",
            provider: "openai",
          },
          models: [
            {
              apiKeyEnv: "OPENAI_API_KEY",
              baseUrl: "https://api.openai.com/v1",
              id: "openai:gpt-5.5",
              label: "GPT-5.5",
              model: "gpt-5.5",
              provider: "openai",
            },
          ],
          switching: {
            available: false,
            mode: "single-active-config",
          },
        },
        kind: "data",
        subject: "models.current",
      },
      type: "result",
    });
  });

  it("marks model switching available when a provider exposes switchModel", async () => {
    const switchModel = vi.fn();
    const { events, service } = createServiceHarness({
      models: {
        currentModel() {
          return {
            apiKeyEnv: "OPENAI_API_KEY",
            baseUrl: "https://api.openai.com/v1",
            id: "openai:gpt-5.5",
            label: "GPT-5.5",
            model: "gpt-5.5",
            provider: "openai",
          };
        },
        listModels() {
          return [
            {
              apiKeyEnv: "OPENAI_API_KEY",
              baseUrl: "https://api.openai.com/v1",
              id: "openai:gpt-5.5",
              label: "GPT-5.5",
              model: "gpt-5.5",
              provider: "openai",
            },
          ];
        },
        switchModel,
      },
    });

    await service.executeCommand(makeInvocation("models", ["models"]));

    expect(events.at(-1)).toMatchObject({
      output: {
        data: {
          switching: {
            available: true,
            mode: "single-active-config",
          },
        },
        kind: "data",
        subject: "models.current",
      },
      type: "result",
    });
  });

  it("redacts unexpected api keys from model command outputs", async () => {
    const modelWithSecret = {
      apiKey: "sk-secret",
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1",
      id: "openai:gpt-5.5",
      label: "GPT-5.5",
      model: "gpt-5.5",
      provider: "openai",
    } as const;
    const { events, service } = createServiceHarness({
      models: {
        currentModel() {
          return modelWithSecret;
        },
        listModels() {
          return [modelWithSecret];
        },
      },
    });

    await service.executeCommand(makeInvocation("status", ["status"]));
    await service.executeCommand(makeInvocation("models", ["models"]));

    const payload = JSON.stringify(events);
    expect(payload).not.toContain("sk-secret");
    expect(payload).not.toContain('"apiKey":"');
    expect(payload).toContain("OPENAI_API_KEY");
  });

  it("opens session selection from /sessions and lists sessions on non-TUI surfaces", async () => {
    const request = vi
      .fn<() => Promise<UiInteractionResponse>>()
      .mockResolvedValue({
        choiceId: "session_1",
        kind: "accepted",
      });
    const selectSession = vi.fn<() => Promise<void>>().mockResolvedValue();
    const { events, service } = createServiceHarness({
      interactionBroker: { request },
      sessions: {
        listSessions() {
          return [{ id: "session_1", title: "First" }];
        },
        selectSession,
      },
    });

    await service.executeCommand(makeInvocation("sessions", ["sessions"]));
    await service.executeCommand({
      ...makeInvocation("sessions", ["sessions"]),
      surface: "headless",
    });

    expect(request).toHaveBeenCalledWith(
      {
        kind: "select-one",
        options: [{ id: "session_1", label: "First" }],
        prompt: "Select session",
        subject: "session",
      },
      expect.objectContaining({ commandRunId: "command_1" }),
    );
    expect(selectSession).toHaveBeenCalledWith("session_1");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: {
            data: { choiceId: "session_1" },
            kind: "session.selected",
          },
          type: "result",
        }),
      ]),
    );
    expect(events.at(-1)).toMatchObject({
      output: {
        kind: "data",
        subject: "session.list",
        data: { sessions: [{ id: "session_1", title: "First" }] },
      },
      type: "result",
    });
  });

  it("creates and selects a new session", async () => {
    const createSession = vi.fn<() => Promise<{ id: string; title: string }>>(
      () => Promise.resolve({ id: "session_new", title: "New session" }),
    );
    const { events, service } = createServiceHarness({
      sessions: {
        createSession,
        listSessions() {
          return [];
        },
      },
    });

    await service.executeCommand(makeInvocation("new", ["new"]));

    expect(createSession).toHaveBeenCalledOnce();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          output: {
            data: {
              session: { id: "session_new", title: "New session" },
            },
            kind: "data",
            subject: "session.created",
          },
          type: "result",
        }),
        expect.objectContaining({
          action: {
            data: { choiceId: "session_new" },
            kind: "session.selected",
          },
          type: "result",
        }),
      ]),
    );
  });

  it("manually compacts the current session", async () => {
    const compactSession = vi.fn(() =>
      Promise.resolve({
        sessionId: "session_1",
        status: "compacted" as const,
        usageAfter: {
          contextLimit: 100,
          currentTokens: 24,
          modelId: "fake-model",
          remainingTokens: 76,
          shouldCompress: false,
          usageRatio: 0.24,
        },
        usageBefore: {
          contextLimit: 100,
          currentTokens: 92,
          modelId: "fake-model",
          remainingTokens: 8,
          shouldCompress: true,
          usageRatio: 0.92,
        },
      }),
    );
    const { events, service } = createServiceHarness({
      compact: {
        compactSession,
      },
    });

    await service.executeCommand(
      makeInvocation("compact", ["compact"], ["--force"]),
    );

    expect(compactSession).toHaveBeenCalledWith({
      force: true,
      sessionId: "session_1",
    });
    expect(
      events.some((event) => {
        const output = event.output;
        return (
          event.type === "result" &&
          isRecord(output) &&
          output.kind === "data" &&
          output.subject === "session.compact"
        );
      }),
    ).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: {
            data: { sessionId: "session_1", status: "compacted" },
            kind: "session.compacted",
          },
          type: "result",
        }),
      ]),
    );
  });

  it("resumes a session from the top-level /resume command", async () => {
    const selectSession = vi.fn<() => Promise<void>>().mockResolvedValue();
    const { events, service } = createServiceHarness({
      sessions: {
        listSessions() {
          return [
            { id: "session_1", title: "First" },
            { id: "session_2", title: "Second" },
          ];
        },
        selectSession,
      },
    });

    await service.executeCommand(
      makeInvocation("resume", ["resume"], ["--session_id", "session_2"]),
    );
    await service.executeCommand(
      makeInvocation("resume", ["resume"], ["session_1"]),
    );

    expect(selectSession).toHaveBeenNthCalledWith(1, "session_2");
    expect(selectSession).toHaveBeenNthCalledWith(2, "session_1");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          output: {
            data: { sessionId: "session_2" },
            kind: "data",
            subject: "session.current",
          },
          type: "result",
        }),
        expect.objectContaining({
          action: {
            data: { choiceId: "session_1" },
            kind: "session.selected",
          },
          type: "result",
        }),
      ]),
    );
  });

  it("fails /resume without an id instead of opening session selection", async () => {
    const { events, service } = createServiceHarness();

    await service.executeCommand(makeInvocation("resume", ["resume"]));
    await service.executeCommand(
      makeInvocation("resume", ["resume"], ["--session_id", "--force"]),
    );

    expect(events.at(1)).toMatchObject({
      error: {
        code: "SESSION_ID_REQUIRED",
        message: "Use /resume --session_id <id> to resume a session",
      },
      type: "failed",
    });
    expect(events.at(3)).toMatchObject({
      error: {
        code: "SESSION_ID_REQUIRED",
        message: "Use /resume --session_id <id> to resume a session",
      },
      type: "failed",
    });
  });

  it("rejects session selections that were not offered", async () => {
    const request = vi
      .fn<() => Promise<UiInteractionResponse>>()
      .mockResolvedValue({
        choiceId: "session_missing",
        kind: "accepted",
      });
    const selectSession = vi.fn<() => Promise<void>>().mockResolvedValue();
    const { events, service } = createServiceHarness({
      interactionBroker: { request },
      sessions: {
        listSessions() {
          return [{ id: "session_1", title: "First" }];
        },
        selectSession,
      },
    });

    await service.executeCommand(makeInvocation("sessions", ["sessions"]));

    expect(selectSession).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      error: {
        code: "INVALID_INTERACTION_RESPONSE",
        message: "Unknown session selection: session_missing",
      },
      type: "failed",
    });
  });

  it("executes exit actions", async () => {
    const exit = vi.fn<() => Promise<void>>().mockResolvedValue();
    const { events, service } = createServiceHarness({ exit });

    await service.executeCommand(makeInvocation("exit", ["exit"]));

    expect(exit).toHaveBeenCalledOnce();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: { kind: "app.exit" },
          type: "result",
        }),
      ]),
    );
  });

  it("reports and updates permission mode and level", async () => {
    let permissionState: UiPermissionState = {
      level: "default",
      mode: "auto",
      sessionRules: [],
    };
    const toggleMode = vi.fn(() => {
      permissionState = {
        ...permissionState,
        mode: permissionState.mode === "auto" ? "plan" : "auto",
      };
      return permissionState.mode;
    });
    const setMode = vi.fn<(mode: UiPermissionState["mode"]) => void>((mode) => {
      permissionState = {
        ...permissionState,
        mode,
      };
    });
    const setLevel = vi.fn<(level: UiPermissionState["level"]) => void>(
      (level) => {
        permissionState = {
          ...permissionState,
          level,
        };
      },
    );
    const { events, service } = createServiceHarness({
      permission: {
        getState() {
          return permissionState;
        },
        setLevel,
        setMode,
        toggleMode,
      },
    });

    await service.executeCommand(
      makeInvocation("permission.toggle-mode", ["permission", "toggle-mode"]),
    );

    expect(toggleMode).toHaveBeenCalledOnce();
    expect(setMode).not.toHaveBeenCalled();
    expect(setLevel).not.toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          output: {
            data: {
              permission: {
                level: "default",
                mode: "plan",
                sessionRules: [],
              },
            },
            kind: "data",
            subject: "permission.mode",
          },
          type: "result",
        }),
        expect.objectContaining({
          action: {
            data: {
              permission: {
                level: "default",
                mode: "plan",
                sessionRules: [],
              },
            },
            kind: "permission.mode.updated",
          },
          type: "result",
        }),
      ]),
    );
  });

  it("changes permission level through the /permission interaction", async () => {
    let permissionState: UiPermissionState = {
      level: "default",
      mode: "auto",
      sessionRules: [],
    };
    const request = vi
      .fn<() => Promise<UiInteractionResponse>>()
      .mockResolvedValue({
        choiceId: "full-access",
        kind: "accepted",
      });
    const setLevel = vi.fn<(level: UiPermissionState["level"]) => void>(
      (level) => {
        permissionState = { ...permissionState, level };
      },
    );
    const { events, service } = createServiceHarness({
      interactionBroker: { request },
      permission: {
        getState() {
          return permissionState;
        },
        setLevel,
        setMode: vi.fn<(mode: UiPermissionState["mode"]) => void>(),
        toggleMode() {
          return permissionState.mode;
        },
      },
    });

    await service.executeCommand(makeInvocation("permission", ["permission"]));

    expect(request).toHaveBeenCalledWith(
      {
        kind: "select-one",
        options: [
          { id: "default", label: "default" },
          { id: "full-access", label: "full-access" },
        ],
        prompt: "Permission level",
        subject: "permission",
      },
      expect.objectContaining({ commandRunId: "command_1" }),
    );
    expect(setLevel).toHaveBeenCalledWith("full-access");
    expect(events.at(-1)).toMatchObject({
      action: {
        data: {
          permission: {
            level: "full-access",
            mode: "auto",
            sessionRules: [],
          },
        },
        kind: "permission.level.updated",
      },
      type: "result",
    });
  });

  it("publishes command.failed for unknown command ids", async () => {
    const { events, service } = createServiceHarness();

    await service.executeCommand(makeInvocation("missing", ["missing"]));

    expect(events.at(-1)).toMatchObject({
      error: {
        code: "COMMAND_NOT_FOUND",
        message: "Command not found: missing",
      },
      type: "failed",
    });
  });

  it("does not accept mode values as permission subcommands", async () => {
    const { events, service } = createServiceHarness();

    await service.executeCommand(
      makeInvocation("permission.plan", ["permission", "plan"]),
    );
    await service.executeCommand(
      makeInvocation("permission.auto", ["permission", "auto"]),
    );

    expect(events.at(1)).toMatchObject({
      error: {
        code: "COMMAND_NOT_FOUND",
        message: "Command not found: permission.plan",
      },
      type: "failed",
    });
    expect(events.at(3)).toMatchObject({
      error: {
        code: "COMMAND_NOT_FOUND",
        message: "Command not found: permission.auto",
      },
      type: "failed",
    });
  });

  it("executes handlers registered with extra command specs", async () => {
    const { events, service } = createServiceHarness({
      extraCommands: [
        {
          argumentMode: "argv",
          category: "system",
          description: "Show diagnostics",
          id: "diagnostics",
          path: ["diagnostics"],
          source: "plugin",
          surfaces: ["tui"],
        },
      ],
      extraHandlers: [
        {
          id: "diagnostics",
          execute(_invocation, context): void {
            context.emitOutput({
              kind: "data",
              subject: "diagnostics",
              data: { ok: true },
            });
          },
        },
      ],
    });

    expect((await service.listCommands({ surface: "tui" })).commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "diagnostics",
          path: ["diagnostics"],
        }),
      ]),
    );

    await service.executeCommand(
      makeInvocation("diagnostics", ["diagnostics"]),
    );

    expect(events.at(-1)).toMatchObject({
      output: {
        data: { ok: true },
        kind: "data",
        subject: "diagnostics",
      },
      type: "result",
    });
  });

  it("aborts pending command interactions by command run", async () => {
    const bus = createBus();
    const broker = createInteractionBroker({
      bus,
      createInteractionId: () => "interaction_1",
    });
    const events: Record<string, unknown>[] = [];
    bus.subscribe(CommandsEvent.Started, (event) => {
      events.push({ ...event, type: "started" });
    });
    bus.subscribe(CommandsEvent.Failed, (event) => {
      events.push({ ...event, type: "failed" });
    });
    const service = createCommandService({
      bus,
      createCommandRunId: createSequence("command"),
      interactionBroker: broker,
      sessions: {
        listSessions() {
          return [{ id: "session_1", title: "First" }];
        },
      },
    });

    const execution = service.executeCommand(
      makeInvocation("sessions", ["sessions"]),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(broker.listPending()).toEqual([
      expect.objectContaining({
        commandRunId: "command_1",
        interactionId: "interaction_1",
      }),
    ]);
    expect(service.abortCommandRun("command_1", "aborted")).toBe(1);
    await execution;

    expect(events.at(-1)).toMatchObject({
      commandRunId: "command_1",
      error: {
        code: "INTERACTION_CANCELLED",
        message: "Session selection cancelled: aborted",
      },
      type: "failed",
    });
  });
});

function createServiceHarness(
  overrides: Partial<Parameters<typeof createCommandService>[0]> = {},
): {
  readonly events: Record<string, unknown>[];
  readonly service: ReturnType<typeof createCommandService>;
} {
  const bus = createBus();
  const events: Record<string, unknown>[] = [];
  bus.subscribe(CommandsEvent.Started, (event) => {
    events.push({ ...event, type: "started" });
  });
  bus.subscribe(CommandsEvent.ResultDelivered, (event) => {
    events.push({ ...event, type: "result" });
  });
  bus.subscribe(CommandsEvent.Failed, (event) => {
    events.push({ ...event, type: "failed" });
  });

  return {
    events,
    service: createCommandService({
      bus,
      createCommandRunId: createSequence("command"),
      now: () => 1_000,
      ...overrides,
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function getArray(
  record: Record<string, unknown>,
  key: string,
): readonly unknown[] {
  const value = record[key];
  return isUnknownArray(value) ? value : [];
}

function getString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

interface CommandDataOutput {
  readonly data: Record<string, unknown>;
  readonly kind: "data";
  readonly subject: string;
}

function dataOutputFrom(event: unknown): CommandDataOutput | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  const output = event.output;
  if (!isRecord(output) || output.kind !== "data") {
    return undefined;
  }
  const data = getRecord(output, "data");
  const subject = getString(output, "subject");
  return data && subject ? { data, kind: "data", subject } : undefined;
}

function dataOutputBySubject(
  events: readonly unknown[],
  subject: string,
): CommandDataOutput | undefined {
  return events
    .map(dataOutputFrom)
    .find((output) => output?.subject === subject);
}

function makeInvocation(
  commandId: string,
  path: readonly string[],
  argv: readonly string[] = [],
): UiCommandInvocation {
  return {
    argv,
    clientInvocationId: "inv_1",
    commandId,
    path,
    raw: `/${path.join(" ")}${argv.length > 0 ? ` ${argv.join(" ")}` : ""}`,
    rawArgs: argv.join(" "),
    sessionId: "session_1",
    surface: "tui",
  };
}

function createSequence(prefix: string): () => string {
  let next = 1;
  return () => {
    const id = `${prefix}_${String(next)}`;
    next += 1;
    return id;
  };
}
