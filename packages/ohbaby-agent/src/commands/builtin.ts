import type { UiCommandAction, UiCommandOutput } from "ohbaby-sdk";
import type {
  CommandHandler,
  CommandModelSummary,
  CommandPolicyState,
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

const DEFAULT_POLICY_STATE: CommandPolicyState = {
  agentState: "ask-before-edit",
  mode: "agent",
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

function currentPolicyState(
  options: CommandServiceOptions,
): CommandPolicyState {
  return options.policy?.getState() ?? DEFAULT_POLICY_STATE;
}

function emitPolicyState(
  options: CommandServiceOptions,
  context: CommandRunContext,
): CommandPolicyState {
  const policy = currentPolicyState(options);
  context.emitOutput(dataOutput("policy.mode", { policy }));
  return policy;
}

function emitPolicyUpdated(
  options: CommandServiceOptions,
  context: CommandRunContext,
): void {
  const policy = emitPolicyState(options, context);
  context.emitAction(action("policy.mode.updated", { policy }));
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
    if (context.surface === "tui") {
      await handleSessionParent(options, context);
      return;
    }
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

async function handleModeChange(
  options: CommandServiceOptions,
  context: CommandRunContext,
  mode: CommandPolicyState["mode"],
): Promise<void> {
  await options.policy?.setMode(mode);
  emitPolicyUpdated(options, context);
}

async function handleModeAutoEdit(
  options: CommandServiceOptions,
  context: CommandRunContext,
): Promise<void> {
  if (currentPolicyState(options).mode !== "agent") {
    await options.policy?.setMode("agent");
  }
  await options.policy?.toggleAgentState();
  emitPolicyUpdated(options, context);
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
      id: "session.list",
      async execute(_invocation, context): Promise<void> {
        context.emitOutput(
          dataOutput("session.list", { sessions: await listSessions(options) }),
        );
      },
    },
    {
      id: "session.resume",
      execute(invocation, context): Promise<void> {
        return handleSessionResume(options, invocation, context);
      },
    },
    {
      id: "mode",
      execute(_invocation, context): void {
        emitPolicyState(options, context);
      },
    },
    {
      id: "mode.agent",
      execute(_invocation, context): Promise<void> {
        return handleModeChange(options, context, "agent");
      },
    },
    {
      id: "mode.ask",
      execute(_invocation, context): Promise<void> {
        return handleModeChange(options, context, "ask");
      },
    },
    {
      id: "mode.plan",
      execute(_invocation, context): Promise<void> {
        return handleModeChange(options, context, "plan");
      },
    },
    {
      id: "mode.auto-edit",
      execute(_invocation, context): Promise<void> {
        return handleModeAutoEdit(options, context);
      },
    },
  ];

  return new Map(handlers.map((handler) => [handler.id, handler]));
}
