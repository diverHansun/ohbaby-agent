import type {
  UiCommandAction,
  UiCommandCatalog,
  UiCommandInvocation,
  UiCommandOutput,
  UiCommandSpec,
  UiCommandSurface,
} from "ohbaby-sdk";
import type {
  CommandHandler,
  CommandMcpServerSummary,
  CommandModelSummary,
  CommandPermissionState,
  CommandRunContext,
  CommandServiceOptions,
  CommandSessionSummary,
  CommandSkillSummary,
} from "./types.js";
import {
  sanitizeCommandMcpServerSummary,
  sanitizeCommandSkillSummary,
} from "./normalize.js";

interface BuiltinHandlerHelpers {
  listCommands?(
    surface?: UiCommandSurface,
  ): Promise<UiCommandCatalog> | UiCommandCatalog;
}

async function listModels(
  options: CommandServiceOptions,
): Promise<readonly CommandModelSummary[]> {
  const models = await (options.models?.listModels() ?? []);
  return models
    .map(sanitizeModelSummary)
    .filter((model): model is CommandModelSummary => model !== null);
}

async function currentModel(
  options: CommandServiceOptions,
): Promise<CommandModelSummary | null> {
  return sanitizeModelSummary((await options.models?.currentModel()) ?? null);
}

async function listSessions(
  options: CommandServiceOptions,
): Promise<readonly CommandSessionSummary[]> {
  return options.sessions?.listSessions() ?? [];
}

async function listMcpServers(
  options: CommandServiceOptions,
): Promise<readonly CommandMcpServerSummary[]> {
  try {
    const servers = await (options.mcps?.listServers() ?? []);
    return servers
      .map(sanitizeCommandMcpServerSummary)
      .filter((server): server is CommandMcpServerSummary => server !== null);
  } catch {
    return [];
  }
}

async function listSkills(
  options: CommandServiceOptions,
): Promise<readonly CommandSkillSummary[]> {
  try {
    const skills = await (options.skills?.listUserInvocable() ?? []);
    return skills
      .map(sanitizeCommandSkillSummary)
      .filter((skill): skill is CommandSkillSummary => skill !== null);
  } catch {
    return [];
  }
}

const DEFAULT_PERMISSION_STATE: CommandPermissionState = {
  level: "default",
  mode: "auto",
  sessionRules: [],
};

function dataOutput(
  subject: string,
  data: Record<string, unknown>,
): UiCommandOutput {
  return { kind: "data", subject, data };
}

function action(kind: string, data?: Record<string, unknown>): UiCommandAction {
  return data ? { kind, data } : { kind };
}

function sanitizeModelSummary(
  model: CommandModelSummary | null,
): CommandModelSummary | null {
  if (!model) {
    return null;
  }

  return {
    id: model.id,
    label: model.label,
    provider: model.provider,
    ...(model.model === undefined ? {} : { model: model.model }),
    ...(model.baseUrl === undefined ? {} : { baseUrl: model.baseUrl }),
    ...(model.apiKeyEnv === undefined ? {} : { apiKeyEnv: model.apiKeyEnv }),
    ...(model.active === undefined ? {} : { active: model.active }),
  };
}

function formatCategoryTitle(category: string): string {
  return category
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function categorizeCommands(commands: readonly UiCommandSpec[]): readonly {
  readonly name: string;
  readonly title: string;
  readonly commands: readonly UiCommandSpec[];
}[] {
  const groups = new Map<string, UiCommandSpec[]>();
  for (const command of commands) {
    groups.set(command.category, [
      ...(groups.get(command.category) ?? []),
      command,
    ]);
  }
  return Array.from(groups.entries()).map(([name, commands]) => ({
    commands,
    name,
    title: formatCategoryTitle(name),
  }));
}

function countTools(tools: readonly { readonly source?: string }[]): {
  readonly builtin: number;
  readonly module: number;
  readonly skill: number;
  readonly mcp: number;
} {
  const counts = {
    builtin: 0,
    mcp: 0,
    module: 0,
    skill: 0,
  };
  for (const tool of tools) {
    switch (tool.source) {
      case "builtin":
        counts.builtin += 1;
        break;
      case "module":
        counts.module += 1;
        break;
      case "skill":
        counts.skill += 1;
        break;
      case "mcp":
        counts.mcp += 1;
        break;
    }
  }
  return counts;
}

function summarizeMcpServers(servers: readonly CommandMcpServerSummary[]): {
  readonly total: number;
  readonly connected: number;
  readonly failed: number;
  readonly disabled: number;
  readonly disconnected: number;
} {
  const summary = {
    connected: 0,
    disabled: 0,
    disconnected: 0,
    failed: 0,
    total: servers.length,
  };
  for (const server of servers) {
    summary[server.status] += 1;
  }
  return summary;
}

function currentPermissionState(
  options: CommandServiceOptions,
): CommandPermissionState {
  return options.permission?.getState() ?? DEFAULT_PERMISSION_STATE;
}

function emitPermissionState(
  options: CommandServiceOptions,
  context: CommandRunContext,
  subject = "permission.level",
): CommandPermissionState {
  const permission = currentPermissionState(options);
  context.emitOutput(dataOutput(subject, { permission }));
  return permission;
}

function emitPermissionUpdated(
  options: CommandServiceOptions,
  context: CommandRunContext,
  input: {
    readonly actionKind: string;
    readonly subject: string;
  },
): void {
  const permission = emitPermissionState(options, context, input.subject);
  context.emitAction(action(input.actionKind, { permission }));
}

async function handleStatus(
  options: CommandServiceOptions,
  invocation: UiCommandInvocation,
  context: CommandRunContext,
): Promise<void> {
  const [models, model, tools, skills, mcpServers, contextUsage, projectRoot] =
    await Promise.all([
      listModels(options),
      currentModel(options),
      options.tools?.listTools() ?? [],
      listSkills(options),
      listMcpServers(options),
      options.getContextUsage?.({ sessionId: invocation.sessionId }) ?? null,
      options.getProjectRoot?.() ?? null,
    ]);
  context.emitOutput(
    dataOutput("status", {
      context: contextUsage,
      mcps: summarizeMcpServers(mcpServers),
      model,
      models,
      projectRoot,
      sessionId: invocation.sessionId ?? null,
      skillsCount: skills.length,
      status: options.getStatus?.() ?? "idle",
      tools: countTools(tools),
    }),
  );
}

async function handleHelp(
  helpers: BuiltinHandlerHelpers,
  context: CommandRunContext,
): Promise<void> {
  const catalog = await helpers.listCommands?.(context.surface);
  const commands = catalog?.commands ?? [];
  context.emitOutput(
    dataOutput("help", {
      categories: categorizeCommands(commands),
      commands,
    }),
  );
}

async function handleMcps(
  options: CommandServiceOptions,
  context: CommandRunContext,
): Promise<void> {
  context.emitOutput(
    dataOutput("mcps", {
      servers: await listMcpServers(options),
    }),
  );
}

async function handleSkills(
  options: CommandServiceOptions,
  context: CommandRunContext,
): Promise<void> {
  const skills = await listSkills(options);
  context.emitOutput(
    dataOutput("skills", {
      skills: skills.map((skill) => ({
        commandId: `skill.${skill.name}`,
        description: skill.description,
        name: skill.name,
        path: [skill.name],
        scope: skill.scope,
        ...(skill.source === undefined ? {} : { source: skill.source }),
      })),
    }),
  );
}

async function handleModels(
  options: CommandServiceOptions,
  context: CommandRunContext,
): Promise<void> {
  const models = await listModels(options);
  context.emitOutput(
    dataOutput("models.current", {
      current: await currentModel(options),
      models,
      switching: {
        available: typeof options.models?.switchModel === "function",
        mode: "single-active-config",
      },
    }),
  );
}

async function handleSessionParent(
  options: CommandServiceOptions,
  context: CommandRunContext,
): Promise<void> {
  const sessions = await listSessions(options);
  if (context.surface !== "tui") {
    context.emitOutput(dataOutput("session.list", { sessions }));
    return;
  }

  const response = await context.requestInteraction({
    kind: "select-one",
    options: sessions.map((session) => ({
      id: session.id,
      label: session.title,
    })),
    prompt: "Select session",
    subject: "session",
  });
  if (response.kind === "cancelled") {
    context.fail({
      code: "INTERACTION_CANCELLED",
      message: `Session selection cancelled: ${response.reason}`,
      recoverable: true,
    });
    return;
  }
  if (!response.choiceId) {
    context.fail({
      code: "INVALID_INTERACTION_RESPONSE",
      message: "Session selection did not include a choice",
      recoverable: true,
    });
    return;
  }
  if (!sessions.some((session) => session.id === response.choiceId)) {
    context.fail({
      code: "INVALID_INTERACTION_RESPONSE",
      message: `Unknown session selection: ${response.choiceId}`,
      recoverable: true,
    });
    return;
  }

  await options.sessions?.selectSession?.(response.choiceId);
  context.emitAction(
    action("session.selected", { choiceId: response.choiceId }),
  );
}

function parseSessionIdArg(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--session_id" || arg === "--session-id") {
      return parseSessionIdValue(argv[index + 1]);
    }
    if (arg.startsWith("--session_id=")) {
      return parseSessionIdValue(arg.slice("--session_id=".length));
    }
    if (arg.startsWith("--session-id=")) {
      return parseSessionIdValue(arg.slice("--session-id=".length));
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
  }

  return undefined;
}

function parseSessionIdValue(value: string | undefined): string | undefined {
  if (!value || value.startsWith("-")) {
    return undefined;
  }
  return value;
}

async function handleSessionResume(
  options: CommandServiceOptions,
  invocation: Parameters<CommandHandler["execute"]>[0],
  context: CommandRunContext,
): Promise<void> {
  const sessionId = parseSessionIdArg(invocation.argv);
  if (!sessionId) {
    context.fail({
      code: "SESSION_ID_REQUIRED",
      message: "Use /resume --session_id <id> to resume a session",
      recoverable: true,
    });
    return;
  }

  if (!options.sessions?.selectSession) {
    context.fail({
      code: "SESSION_RESUME_UNAVAILABLE",
      message: "Session resume is not available in this backend",
      recoverable: true,
    });
    return;
  }

  await options.sessions.selectSession(sessionId);
  context.emitOutput(dataOutput("session.current", { sessionId }));
  context.emitAction(action("session.selected", { choiceId: sessionId }));
}

async function handleSessionNew(
  options: CommandServiceOptions,
  context: CommandRunContext,
): Promise<void> {
  if (!options.sessions?.createSession) {
    context.fail({
      code: "SESSION_CREATE_UNAVAILABLE",
      message: "Session creation is not available in this backend",
      recoverable: true,
    });
    return;
  }

  const session = await options.sessions.createSession();
  context.emitOutput(dataOutput("session.created", { session }));
  context.emitAction(action("session.selected", { choiceId: session.id }));
}

function parseForceArg(
  argv: readonly string[],
  defaultValue: boolean,
): boolean {
  if (argv.includes("--no-force")) {
    return false;
  }
  if (argv.includes("--force")) {
    return true;
  }
  return defaultValue;
}

async function handleSessionCompact(
  options: CommandServiceOptions,
  invocation: Parameters<CommandHandler["execute"]>[0],
  context: CommandRunContext,
): Promise<void> {
  if (!options.compact) {
    context.fail({
      code: "SESSION_COMPACT_UNAVAILABLE",
      message: "Session compact is not available in this backend",
      recoverable: true,
    });
    return;
  }

  const result = await options.compact.compactSession({
    force: parseForceArg(invocation.argv, true),
    sessionId: parseSessionIdArg(invocation.argv) ?? invocation.sessionId,
  });
  context.emitOutput(dataOutput("session.compact", { result }));
  context.emitAction(
    action("session.compacted", {
      sessionId: result.sessionId,
      status: result.status,
    }),
  );
}

async function handleModeToggle(
  options: CommandServiceOptions,
  context: CommandRunContext,
): Promise<void> {
  if (context.surface !== "tui") {
    context.fail({
      code: "PERMISSION_MODE_TOGGLE_UNAVAILABLE",
      message: "Mode can only be changed from the interactive TUI",
      recoverable: true,
    });
    return;
  }
  await options.permission?.toggleMode();
  emitPermissionUpdated(options, context, {
    actionKind: "permission.mode.updated",
    subject: "permission.mode",
  });
}

async function handlePermissionLevelSelection(
  options: CommandServiceOptions,
  context: CommandRunContext,
): Promise<void> {
  if (context.surface !== "tui") {
    emitPermissionState(options, context);
    return;
  }

  const response = await context.requestInteraction({
    kind: "select-one",
    options: [
      {
        id: "default",
        label: "default",
      },
      {
        id: "full-access",
        label: "full-access",
      },
    ],
    prompt: "Permission level",
    subject: "permission",
  });
  if (response.kind === "cancelled") {
    context.fail({
      code: "INTERACTION_CANCELLED",
      message: `Permission selection cancelled: ${response.reason}`,
      recoverable: true,
    });
    return;
  }
  if (response.choiceId !== "default" && response.choiceId !== "full-access") {
    context.fail({
      code: "INVALID_INTERACTION_RESPONSE",
      message: "Permission selection did not include a valid level",
      recoverable: true,
    });
    return;
  }

  await handlePermissionLevelChange(options, context, response.choiceId);
}

async function handlePermissionLevelChange(
  options: CommandServiceOptions,
  context: CommandRunContext,
  level: CommandPermissionState["level"],
): Promise<void> {
  await options.permission?.setLevel(level);
  emitPermissionUpdated(options, context, {
    actionKind: "permission.level.updated",
    subject: "permission.level",
  });
}

export function createBuiltinHandlers(
  options: CommandServiceOptions,
  helpers: BuiltinHandlerHelpers = {},
): Map<string, CommandHandler> {
  const handlers: CommandHandler[] = [
    {
      id: "status",
      execute(invocation, context): Promise<void> {
        return handleStatus(options, invocation, context);
      },
    },
    {
      id: "help",
      async execute(_invocation, context): Promise<void> {
        return handleHelp(helpers, context);
      },
    },
    {
      id: "exit",
      async execute(_invocation, context): Promise<void> {
        await options.exit?.();
        context.emitAction(action("app.exit"));
      },
    },
    {
      id: "models",
      execute(_invocation, context): Promise<void> {
        return handleModels(options, context);
      },
    },
    {
      id: "sessions",
      execute(_invocation, context): Promise<void> {
        return handleSessionParent(options, context);
      },
    },
    {
      id: "new",
      execute(_invocation, context): Promise<void> {
        return handleSessionNew(options, context);
      },
    },
    {
      id: "compact",
      execute(invocation, context): Promise<void> {
        return handleSessionCompact(options, invocation, context);
      },
    },
    {
      id: "resume",
      execute(invocation, context): Promise<void> {
        return handleSessionResume(options, invocation, context);
      },
    },
    {
      id: "permission",
      execute(_invocation, context): Promise<void> {
        return handlePermissionLevelSelection(options, context);
      },
    },
    {
      id: "mcps",
      execute(_invocation, context): Promise<void> {
        return handleMcps(options, context);
      },
    },
    {
      id: "skills",
      execute(_invocation, context): Promise<void> {
        return handleSkills(options, context);
      },
    },
    {
      id: "permission.toggle-mode",
      execute(_invocation, context): Promise<void> {
        return handleModeToggle(options, context);
      },
    },
  ];

  return new Map(handlers.map((handler) => [handler.id, handler]));
}
