import type { UiEvent } from "ohbaby-sdk";
import type { BusEventDefinition, BusEventPayload } from "../../bus/index.js";
import { CommandsEvent } from "../../commands/index.js";
import { InteractionEvent } from "../../runtime/interaction-broker/index.js";

export type AppProjectedUiEvent =
  | Extract<UiEvent, { type: "command.started" }>
  | Extract<UiEvent, { type: "command.result.delivered" }>
  | Extract<UiEvent, { type: "command.failed" }>
  | Extract<UiEvent, { type: "command.catalog.updated" }>
  | Extract<UiEvent, { type: "interaction.requested" }>
  | Extract<UiEvent, { type: "interaction.resolved" }>;

export type AppProjectedEventType = AppProjectedUiEvent["type"];

export type AppProjectedUiEventFor<Type extends AppProjectedEventType> =
  Extract<AppProjectedUiEvent, { type: Type }>;

export interface ProjectedAppEvent<
  Type extends AppProjectedEventType = AppProjectedEventType,
> {
  readonly type: Type;
  readonly uiEvent: AppProjectedUiEventFor<Type>;
}

export interface AppStreamEvent<
  Type extends AppProjectedEventType = AppProjectedEventType,
> {
  readonly type: Type;
  readonly data: Omit<AppProjectedUiEventFor<Type>, "type">;
}

export interface AppEventProjector<
  Event extends BusEventDefinition = BusEventDefinition,
  Type extends AppProjectedEventType = AppProjectedEventType,
> {
  readonly event: Event;
  project(payload: BusEventPayload<Event>): ProjectedAppEvent<Type>;
}

type CommandStartedPayload = BusEventPayload<typeof CommandsEvent.Started>;
type CommandResultDeliveredPayload = BusEventPayload<
  typeof CommandsEvent.ResultDelivered
>;
type CommandFailedPayload = BusEventPayload<typeof CommandsEvent.Failed>;
type CommandCatalogUpdatedPayload = BusEventPayload<
  typeof CommandsEvent.CatalogUpdated
>;
type InteractionRequestedPayload = BusEventPayload<
  typeof InteractionEvent.Requested
>;
type InteractionResolvedPayload = BusEventPayload<
  typeof InteractionEvent.Resolved
>;

function withDefined<T extends object>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as T;
}

function projected<Type extends AppProjectedEventType>(
  type: Type,
  uiEvent: AppProjectedUiEventFor<Type>,
): ProjectedAppEvent<Type> {
  return { type, uiEvent };
}

function projectCommandStarted(
  payload: CommandStartedPayload,
): ProjectedAppEvent<"command.started"> {
  return projected("command.started", {
    command: withDefined({
      commandRunId: payload.commandRunId,
      clientInvocationId: payload.clientInvocationId,
      commandId: payload.commandId,
      path: payload.path,
      surface: payload.surface,
      sessionId: payload.sessionId,
    }),
    timestamp: payload.timestamp,
    type: "command.started",
  });
}

function projectCommandResultDelivered(
  payload: CommandResultDeliveredPayload,
): ProjectedAppEvent<"command.result.delivered"> {
  return projected("command.result.delivered", {
    ...withDefined({
      commandRunId: payload.commandRunId,
      clientInvocationId: payload.clientInvocationId,
      output: payload.output,
      action: payload.action,
      timestamp: payload.timestamp,
    }),
    type: "command.result.delivered",
  });
}

function projectCommandFailed(
  payload: CommandFailedPayload,
): ProjectedAppEvent<"command.failed"> {
  return projected("command.failed", {
    commandRunId: payload.commandRunId,
    clientInvocationId: payload.clientInvocationId,
    error: payload.error,
    timestamp: payload.timestamp,
    type: "command.failed",
  });
}

function projectCommandCatalogUpdated(
  payload: CommandCatalogUpdatedPayload,
): ProjectedAppEvent<"command.catalog.updated"> {
  return projected("command.catalog.updated", {
    ...withDefined({
      version: payload.version,
      reason: payload.reason,
      timestamp: payload.timestamp,
    }),
    type: "command.catalog.updated",
  });
}

function projectInteractionRequested(
  payload: InteractionRequestedPayload,
): ProjectedAppEvent<"interaction.requested"> {
  return projected("interaction.requested", {
    request: payload.request,
    timestamp: payload.timestamp,
    type: "interaction.requested",
  });
}

function projectInteractionResolved(
  payload: InteractionResolvedPayload,
): ProjectedAppEvent<"interaction.resolved"> {
  return projected("interaction.resolved", {
    ...withDefined({
      interactionId: payload.interactionId,
      commandRunId: payload.commandRunId,
      clientInvocationId: payload.clientInvocationId,
      status: payload.response.kind,
      timestamp: payload.timestamp,
    }),
    type: "interaction.resolved",
  });
}

function appEventProjector<
  Event extends BusEventDefinition,
  Type extends AppProjectedEventType,
>(
  event: Event,
  project: (payload: BusEventPayload<Event>) => ProjectedAppEvent<Type>,
): AppEventProjector<Event, Type> {
  return { event, project };
}

export const appEventProjectors = [
  appEventProjector(CommandsEvent.Started, projectCommandStarted),
  appEventProjector(CommandsEvent.ResultDelivered, projectCommandResultDelivered),
  appEventProjector(CommandsEvent.Failed, projectCommandFailed),
  appEventProjector(CommandsEvent.CatalogUpdated, projectCommandCatalogUpdated),
  appEventProjector(InteractionEvent.Requested, projectInteractionRequested),
  appEventProjector(InteractionEvent.Resolved, projectInteractionResolved),
] as const;

export function toAppStreamEvent<Type extends AppProjectedEventType>(
  projectedEvent: ProjectedAppEvent<Type>,
): AppStreamEvent<Type> {
  const { type: _type, ...data } = projectedEvent.uiEvent;

  return {
    type: projectedEvent.type,
    data: withDefined(data),
  };
}
