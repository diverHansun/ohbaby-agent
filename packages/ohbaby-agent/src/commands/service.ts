import type { UiCommandCatalog, UiCommandInvocation } from "ohbaby-sdk";
import {
  buildCommandCatalog,
  filterCommandCatalogBySurface,
} from "./catalog.js";
import { CommandsEvent } from "./events.js";
import { createCommandRunContext } from "./run-context.js";
import { createBuiltinHandlers } from "./builtin.js";
import type { CommandService, CommandServiceOptions } from "./types.js";

function createDefaultCommandRunId(): () => string {
  let next = 1;
  return () => {
    const id = `command_${String(next)}`;
    next += 1;
    return id;
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function createCommandService(
  options: CommandServiceOptions,
): CommandService {
  const catalog = buildCommandCatalog({
    extraCommands: options.extraCommands,
  });
  const handlers = createBuiltinHandlers(options);
  for (const handler of options.extraHandlers ?? []) {
    handlers.set(handler.id, handler);
  }
  const createCommandRunId =
    options.createCommandRunId ?? createDefaultCommandRunId();
  const now = options.now ?? Date.now;

  return {
    listCommands(query): UiCommandCatalog {
      return filterCommandCatalogBySurface(catalog, query.surface);
    },

    async executeCommand(invocation: UiCommandInvocation): Promise<void> {
      const commandRunId = createCommandRunId();
      const context = createCommandRunContext({
        commandRunId,
        clientInvocationId: invocation.clientInvocationId,
        sessionId: invocation.sessionId,
        surface: invocation.surface,
        options,
      });

      options.bus.publish(CommandsEvent.Started, {
        commandRunId,
        clientInvocationId: invocation.clientInvocationId,
        commandId: invocation.commandId,
        path: [...invocation.path],
        surface: invocation.surface,
        sessionId: invocation.sessionId,
        timestamp: now(),
      });

      const handler = handlers.get(invocation.commandId);
      if (!handler) {
        context.fail({
          code: "COMMAND_NOT_FOUND",
          message: `Command not found: ${invocation.commandId}`,
          recoverable: true,
        });
        return;
      }

      try {
        await handler.execute(invocation, context);
      } catch (error) {
        context.fail({
          code: "EXECUTION_ERROR",
          message: getErrorMessage(error),
          recoverable: true,
        });
      }
    },

    abortCommandRun(commandRunId: string, reason = "aborted"): number {
      return (
        options.interactionBroker?.abortByCommandRun?.(commandRunId, reason) ??
        0
      );
    },
  };
}
