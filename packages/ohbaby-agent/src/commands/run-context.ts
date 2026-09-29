import type {
  UiCommandCompletion,
  UiPromptReceipt,
  UiCommandAction,
  UiCommandError,
  UiCommandOutput,
  UiCommandSurface,
  UiInteractionResponse,
} from "ohbaby-sdk";
import { CommandsEvent } from "./events.js";
import type { CommandRunContext, CommandServiceOptions } from "./types.js";

export function createCommandRunContext(input: {
  readonly commandRunId: string;
  readonly clientInvocationId: string;
  readonly sessionId?: string;
  readonly surface: UiCommandSurface;
  readonly options: CommandServiceOptions;
}): CommandRunContext & {
  completion(promptReceipt?: UiPromptReceipt): UiCommandCompletion;
} {
  const now = input.options.now ?? Date.now;
  let firstError: UiCommandError | undefined;
  let outputCount = 0;
  let eventCount = 0;

  return {
    completion(promptReceipt): UiCommandCompletion {
      return {
        commandRunId: input.commandRunId,
        clientInvocationId: input.clientInvocationId,
        ...(input.sessionId === undefined
          ? {}
          : { sessionId: input.sessionId }),
        outputCount,
        eventCount,
        ...(promptReceipt === undefined ? {} : { promptReceipt }),
        ...(firstError
          ? { status: "failed" as const, error: firstError }
          : { status: "completed" as const }),
      };
    },
    commandRunId: input.commandRunId,
    clientInvocationId: input.clientInvocationId,
    sessionId: input.sessionId,
    surface: input.surface,

    emitOutput(output: UiCommandOutput): void {
      outputCount += 1;
      eventCount += 1;
      input.options.bus.publish(CommandsEvent.ResultDelivered, {
        commandRunId: input.commandRunId,
        clientInvocationId: input.clientInvocationId,
        output,
        timestamp: now(),
      });
    },

    emitAction(action: UiCommandAction): void {
      eventCount += 1;
      input.options.bus.publish(CommandsEvent.ResultDelivered, {
        commandRunId: input.commandRunId,
        clientInvocationId: input.clientInvocationId,
        action,
        timestamp: now(),
      });
    },

    fail(error: UiCommandError): void {
      firstError ??= error;
      eventCount += 1;
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
