import { describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import { CommandsEvent } from "../../commands/index.js";
import { InteractionEvent } from "../interaction-broker/index.js";
import type {
  StreamBridge,
  StreamBridgeYield,
} from "../stream-bridge/index.js";
import { startCommandEventAdapter } from "./command-events.js";

describe("startCommandEventAdapter", () => {
  it("projects command and interaction bus events to SDK app events", () => {
    const bus = createBus();
    const streamBridge = new RecordingStreamBridge();
    const adapter = startCommandEventAdapter({ bus, streamBridge });

    bus.publish(CommandsEvent.Started, {
      clientInvocationId: "inv_1",
      commandId: "status",
      commandRunId: "cmd_1",
      path: ["status"],
      sessionId: "session_1",
      surface: "tui",
      timestamp: 1,
    });
    bus.publish(CommandsEvent.ResultDelivered, {
      clientInvocationId: "inv_1",
      commandRunId: "cmd_1",
      output: { kind: "text", text: "OK" },
      timestamp: 2,
    });
    bus.publish(CommandsEvent.Failed, {
      clientInvocationId: "inv_2",
      commandRunId: "cmd_2",
      error: { code: "INVALID_ARGS", message: "bad args" },
      timestamp: 3,
    });
    bus.publish(InteractionEvent.Requested, {
      request: {
        clientInvocationId: "inv_3",
        commandRunId: "cmd_3",
        interactionId: "interaction_1",
        kind: "select-one",
        subject: "model",
      },
      timestamp: 4,
    });
    bus.publish(InteractionEvent.Resolved, {
      clientInvocationId: "inv_3",
      commandRunId: "cmd_3",
      interactionId: "interaction_1",
      response: { kind: "cancelled", reason: "user-cancelled" },
      timestamp: 5,
    });

    expect(streamBridge.published).toEqual([
      {
        data: {
          command: {
            clientInvocationId: "inv_1",
            commandId: "status",
            commandRunId: "cmd_1",
            path: ["status"],
            sessionId: "session_1",
            surface: "tui",
          },
          timestamp: 1,
        },
        event: "command.started",
        scope: "app",
      },
      {
        data: {
          clientInvocationId: "inv_1",
          commandRunId: "cmd_1",
          output: { kind: "text", text: "OK" },
          timestamp: 2,
        },
        event: "command.result.delivered",
        scope: "app",
      },
      {
        data: {
          clientInvocationId: "inv_2",
          commandRunId: "cmd_2",
          error: { code: "INVALID_ARGS", message: "bad args" },
          timestamp: 3,
        },
        event: "command.failed",
        scope: "app",
      },
      {
        data: {
          request: {
            clientInvocationId: "inv_3",
            commandRunId: "cmd_3",
            interactionId: "interaction_1",
            kind: "select-one",
            subject: "model",
          },
          timestamp: 4,
        },
        event: "interaction.requested",
        scope: "app",
      },
      {
        data: {
          clientInvocationId: "inv_3",
          commandRunId: "cmd_3",
          interactionId: "interaction_1",
          status: "cancelled",
          timestamp: 5,
        },
        event: "interaction.resolved",
        scope: "app",
      },
    ]);

    void adapter.dispose();
    bus.publish(CommandsEvent.ResultDelivered, {
      clientInvocationId: "inv_after",
      commandRunId: "cmd_after",
      output: { kind: "text", text: "after dispose" },
      timestamp: 6,
    });
    expect(streamBridge.published).toHaveLength(5);
  });
});

class RecordingStreamBridge implements StreamBridge {
  readonly published: {
    readonly scope: string;
    readonly event: string;
    readonly data: unknown;
  }[] = [];

  publish(
    scope: "app" | `run/${string}`,
    event: string,
    data: unknown,
  ): number {
    this.published.push({ scope, event, data });
    return this.published.length;
  }

  subscribe(): AsyncIterable<StreamBridgeYield> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamBridgeYield> {
        return {
          next(): Promise<IteratorResult<StreamBridgeYield>> {
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
  }

  end(): void {
    // No-op for this projection test.
  }
}
