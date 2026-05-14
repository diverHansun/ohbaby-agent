import type { DaemonEventAdapter, DaemonEventAdapterDeps } from "./types.js";
import { CommandsEvent } from "../../commands/index.js";
import { InteractionEvent } from "../interaction-broker/index.js";

function withDefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

export function startCommandEventAdapter({
  bus,
  streamBridge,
  eventDefinitions = [],
}: DaemonEventAdapterDeps): DaemonEventAdapter {
  const unsubscribers = [
    bus.subscribe(CommandsEvent.Started, (payload) => {
      streamBridge.publish("app", "command.started", {
        command: withDefined({
          commandRunId: payload.commandRunId,
          clientInvocationId: payload.clientInvocationId,
          commandId: payload.commandId,
          path: payload.path,
          surface: payload.surface,
          sessionId: payload.sessionId,
        }),
        timestamp: payload.timestamp,
      });
    }),
    bus.subscribe(CommandsEvent.ResultDelivered, (payload) => {
      streamBridge.publish(
        "app",
        "command.result.delivered",
        withDefined({
          commandRunId: payload.commandRunId,
          clientInvocationId: payload.clientInvocationId,
          output: payload.output,
          action: payload.action,
          timestamp: payload.timestamp,
        }),
      );
    }),
    bus.subscribe(CommandsEvent.Failed, (payload) => {
      streamBridge.publish("app", "command.failed", {
        commandRunId: payload.commandRunId,
        clientInvocationId: payload.clientInvocationId,
        error: payload.error,
        timestamp: payload.timestamp,
      });
    }),
    bus.subscribe(CommandsEvent.CatalogUpdated, (payload) => {
      streamBridge.publish(
        "app",
        "command.catalog.updated",
        withDefined({
          version: payload.version,
          reason: payload.reason,
          timestamp: payload.timestamp,
        }),
      );
    }),
    bus.subscribe(InteractionEvent.Requested, (payload) => {
      streamBridge.publish("app", "interaction.requested", {
        request: payload.request,
        timestamp: payload.timestamp,
      });
    }),
    bus.subscribe(InteractionEvent.Resolved, (payload) => {
      streamBridge.publish(
        "app",
        "interaction.resolved",
        withDefined({
          interactionId: payload.interactionId,
          commandRunId: payload.commandRunId,
          clientInvocationId: payload.clientInvocationId,
          status: payload.response.kind,
          timestamp: payload.timestamp,
        }),
      );
    }),
    ...eventDefinitions.map((eventDefinition) =>
      bus.subscribe(eventDefinition, (payload) => {
        streamBridge.publish("app", eventDefinition.type, payload);
      }),
    ),
  ];

  return {
    dispose(): void {
      for (const unsubscribe of unsubscribers.splice(0)) {
        unsubscribe();
      }
    },
  };
}
