import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BusEvent, createBus } from "../../bus/index.js";
import { CommandsEvent } from "../../commands/index.js";
import type { ProjectedAppEvent } from "./projectors.js";
import { subscribeAppEventProjectors } from "./subscriptions.js";

describe("subscribeAppEventProjectors", () => {
  it("projects known bus events and disposes all subscriptions once", () => {
    const bus = createBus();
    const projectedEvents: ProjectedAppEvent[] = [];
    const dispose = subscribeAppEventProjectors({
      bus,
      target: (event) => {
        projectedEvents.push(event);
      },
    });

    bus.publish(CommandsEvent.ResultDelivered, {
      clientInvocationId: "inv_1",
      commandRunId: "cmd_1",
      output: { kind: "text", text: "OK" },
      timestamp: 1,
    });

    expect(projectedEvents).toEqual([
      {
        type: "command.result.delivered",
        uiEvent: {
          clientInvocationId: "inv_1",
          commandRunId: "cmd_1",
          output: { kind: "text", text: "OK" },
          timestamp: 1,
          type: "command.result.delivered",
        },
      },
    ]);

    dispose();
    dispose();
    bus.publish(CommandsEvent.ResultDelivered, {
      clientInvocationId: "inv_after",
      commandRunId: "cmd_after",
      output: { kind: "text", text: "after dispose" },
      timestamp: 2,
    });

    expect(projectedEvents).toHaveLength(1);
  });

  it("does not forward arbitrary bus events", () => {
    const bus = createBus();
    const projectedEvents: ProjectedAppEvent[] = [];
    const arbitraryEvent = BusEvent.define(
      "daemon.test.arbitrary",
      z.object({ value: z.string() }),
    );
    subscribeAppEventProjectors({
      bus,
      target: (event) => {
        projectedEvents.push(event);
      },
    });

    bus.publish(arbitraryEvent, { value: "ignored" });

    expect(projectedEvents).toEqual([]);
  });

  it("reports synchronous projector or target errors without throwing through Bus", () => {
    const bus = createBus();
    const targetError = new Error("target failed");
    const errors: { readonly eventType: string; readonly error: unknown }[] = [];
    subscribeAppEventProjectors({
      bus,
      target: () => {
        throw targetError;
      },
      onError: (error) => {
        errors.push(error);
      },
    });

    expect(() => {
      bus.publish(CommandsEvent.Failed, {
        clientInvocationId: "inv_1",
        commandRunId: "cmd_1",
        error: { code: "INVALID_ARGS", message: "bad args" },
        timestamp: 1,
      });
    }).not.toThrow();

    expect(errors).toEqual([
      {
        eventType: "commands.failed.internal",
        error: targetError,
      },
    ]);
  });
});
