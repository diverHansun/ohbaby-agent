import type { UiCommandAction, UiCommandOutput } from "ohbaby-sdk";
import type {
  CommandHandler,
  CommandModelSummary,
  CommandPermissionState,
  CommandRunContext,
  CommandServiceOptions,
  CommandSessionSummary,
  CommandToolSummary,
} from "./types.js";

async function listTools(
  options: CommandServiceOptions,
): Promise<readonly CommandToolSummary[]> {
  return options.tools?.listTools() ?? [];
}

async function listModels(
  options: CommandServiceOptions,
): Promise<readonly CommandModelSummary[]> {
  return options.models?.listModels() ?? [];
}

async function currentModel(
  options: CommandServiceOptions,
): Promise<CommandModelSummary | null> {
  return options.models?.currentModel() ?? null;
}

async function listSessions(
  options: CommandServiceOptions,
): Promise<readonly CommandSessionSummary[]> {
  return options.sessions?.listSessions() ?? [];
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

async function handleModelParent(
  options: CommandServiceOptions,
  context: CommandRunContext,
): Promise<void> {
  const models = await listModels(options);
  context.emitOutput(
    dataOutput("model.current", {
      model: await currentModel(options),
      models,
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
      return argv[index + 1];
    }
    if (arg.startsWith("--session_id=")) {
      return arg.slice("--session_id=".length);
    }
    if (arg.startsWith("--session-id=")) {
      return arg.slice("--session-id=".length);
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
  }

  return undefined;
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
): Map<string, CommandHandler> {
  const handlers: CommandHandler[] = [
    {
      id: "status",
      execute(_invocation, context): void {
        context.emitOutput(
          dataOutput("status", { status: options.getStatus?.() ?? "idle" }),
        );
      },
    },
    {
      id: "tools",
      async execute(_invocation, context): Promise<void> {
        context.emitOutput(
          dataOutput("tools", { tools: await listTools(options) }),
        );
      },
    },
    {
      id: "abort",
      async execute(invocation, context): Promise<void> {
        await options.abortRun?.(invocation.argv[0]);
        context.emitAction(action("run.abort"));
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
      id: "model",
      execute(_invocation, context): Promise<void> {
        return handleModelParent(options, context);
      },
    },
    {
      id: "model.list",
      async execute(_invocation, context): Promise<void> {
        context.emitOutput(
          dataOutput("model.list", { models: await listModels(options) }),
        );
      },
    },
    {
      id: "model.current",
      async execute(_invocation, context): Promise<void> {
        context.emitOutput(
          dataOutput("model.current", { model: await currentModel(options) }),
        );
      },
    },
    {
      id: "session",
      execute(_invocation, context): Promise<void> {
        return handleSessionParent(options, context);
      },
    },
    {
      id: "session.new",
      execute(_invocation, context): Promise<void> {
        return handleSessionNew(options, context);
      },
    },
    {
      id: "session.compact",
      execute(invocation, context): Promise<void> {
        return handleSessionCompact(options, invocation, context);
      },
    },
    {
      id: "session.resume",
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
      id: "permission.default",
      execute(_invocation, context): Promise<void> {
        return handlePermissionLevelChange(options, context, "default");
      },
    },
    {
      id: "permission.full-access",
      execute(_invocation, context): Promise<void> {
        return handlePermissionLevelChange(options, context, "full-access");
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
