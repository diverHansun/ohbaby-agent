import type {
  UiCommandAction,
  UiCommandError,
  UiCommandOutput,
  UiCommandSurface,
  UiInteractionResponse,
} from "ohbaby-sdk";
import { CommandsEvent } from "./events.js";
import type {
  CommandRunContext,
  CommandServiceOptions,
} from "./types.js";

export function createCommandRunContext(input: {
  readonly commandRunId: string;
  readonly clientInvocationId: string;
  readonly sessionId?: string;
  readonly surface: UiCommandSurface;
  readonly options: CommandServiceOptions;
}): CommandRunContext {
  const now = input.options.now ?? Date.now;

  return {
    commandRunId: input.commandRunId,
    clientInvocationId: input.clientInvocationId,
    sessionId: input.sessionId,
    surface: input.surface,

    emitOutput(output: UiCommandOutput): void {
      input.options.bus.publish(CommandsEvent.ResultDelivered, {
        commandRunId: input.commandRunId,
        clientInvocationId: input.clientInvocationId,
        output,
        timestamp: now(),
      });
    },

    emitAction(action: UiCommandAction): void {
      input.options.bus.publish(CommandsEvent.ResultDelivered, {
        commandRunId: input.commandRunId,
        clientInvocationId: input.clientInvocationId,
        action,
        timestamp: now(),
      });
    },

    fail(error: UiCommandError): void {
      input.options.bus.publish(CommandsEvent.Failed, {
        commandRunId: input.commandRunId,
        clientInvocationId: input.clientInvocationId,
        error,
        timestamp: now(),
      });
    },

    requestInteraction(request): Promise<UiInteractionResponse> {
      if (!input.options.interactionBroker) {
        return Promise.resolve({
          kind: "cancelled",
          reason: "interaction-unavailable",
        });
      }

      return input.options.interactionBroker.request(request, {
        commandRunId: input.commandRunId,
        clientInvocationId: input.clientInvocationId,
        sessionId: input.sessionId,
      });
    },
  };
}
