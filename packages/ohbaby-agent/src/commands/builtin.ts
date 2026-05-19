import type { UiCommandAction, UiCommandOutput } from "ohbaby-sdk";
import type {
  CommandHandler,
  CommandModelSummary,
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

function dataOutput(subject: string, data: Record<string, unknown>): UiCommandOutput {
  return { kind: "data", subject, data };
}

function action(kind: string, data?: Record<string, unknown>): UiCommandAction {
  return data ? { kind, data } : { kind };
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
  context.emitAction(action("session.selected", { choiceId: response.choiceId }));
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
        context.emitOutput(dataOutput("tools", { tools: await listTools(options) }));
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
        context.emitOutput(dataOutput("model.list", { models: await listModels(options) }));
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
  ];

  return new Map(handlers.map((handler) => [handler.id, handler]));
}
