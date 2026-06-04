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

type ProjectedAppEventUnion = {
  readonly [EventType in AppProjectedEventType]: {
    readonly type: EventType;
    readonly uiEvent: AppProjectedUiEventFor<EventType>;
  };
}[AppProjectedEventType];

export type ProjectedAppEvent<
  Type extends AppProjectedEventType = AppProjectedEventType,
> = Extract<ProjectedAppEventUnion, { readonly type: Type }>;

type AppStreamEventUnion = {
  readonly [EventType in AppProjectedEventType]: {
    readonly type: EventType;
    readonly data: Omit<AppProjectedUiEventFor<EventType>, "type">;
  };
}[AppProjectedEventType];

export type AppStreamEvent<
  Type extends AppProjectedEventType = AppProjectedEventType,
> = Extract<AppStreamEventUnion, { readonly type: Type }>;

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

function projectCommandStarted(
  payload: CommandStartedPayload,
): ProjectedAppEvent<"command.started"> {
  return {
    type: "command.started",
    uiEvent: {
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
    },
  };
}

function projectCommandResultDelivered(
  payload: CommandResultDeliveredPayload,
): ProjectedAppEvent<"command.result.delivered"> {
  return {
    type: "command.result.delivered",
    uiEvent: {
      ...withDefined({
        commandRunId: payload.commandRunId,
        clientInvocationId: payload.clientInvocationId,
        output: payload.output,
        action: payload.action,
        timestamp: payload.timestamp,
      }),
      type: "command.result.delivered",
    },
  };
}

function projectCommandFailed(
  payload: CommandFailedPayload,
): ProjectedAppEvent<"command.failed"> {
  return {
    type: "command.failed",
    uiEvent: {
      commandRunId: payload.commandRunId,
      clientInvocationId: payload.clientInvocationId,
      error: payload.error,
      timestamp: payload.timestamp,
      type: "command.failed",
    },
  };
}

function projectCommandCatalogUpdated(
  payload: CommandCatalogUpdatedPayload,
): ProjectedAppEvent<"command.catalog.updated"> {
  return {
    type: "command.catalog.updated",
    uiEvent: {
      ...withDefined({
        version: payload.version,
        reason: payload.reason,
        timestamp: payload.timestamp,
      }),
      type: "command.catalog.updated",
    },
  };
}

function projectInteractionRequested(
  payload: InteractionRequestedPayload,
): ProjectedAppEvent<"interaction.requested"> {
  return {
    type: "interaction.requested",
    uiEvent: {
      request: payload.request,
      timestamp: payload.timestamp,
      type: "interaction.requested",
    },
  };
}

function projectInteractionResolved(
  payload: InteractionResolvedPayload,
): ProjectedAppEvent<"interaction.resolved"> {
  return {
    type: "interaction.resolved",
    uiEvent: {
      ...withDefined({
        interactionId: payload.interactionId,
        commandRunId: payload.commandRunId,
        clientInvocationId: payload.clientInvocationId,
        status: payload.response.kind,
        timestamp: payload.timestamp,
      }),
      type: "interaction.resolved",
    },
  };
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

export function toAppStreamEvent(
  projectedEvent: ProjectedAppEvent,
): AppStreamEvent {
  switch (projectedEvent.type) {
    case "command.started": {
      const { type: _type, ...data } = projectedEvent.uiEvent;
      return { type: projectedEvent.type, data: withDefined(data) };
    }
    case "command.result.delivered": {
      const { type: _type, ...data } = projectedEvent.uiEvent;
      return { type: projectedEvent.type, data: withDefined(data) };
    }
    case "command.failed": {
      const { type: _type, ...data } = projectedEvent.uiEvent;
      return { type: projectedEvent.type, data: withDefined(data) };
    }
    case "command.catalog.updated": {
      const { type: _type, ...data } = projectedEvent.uiEvent;
      return { type: projectedEvent.type, data: withDefined(data) };
    }
    case "interaction.requested": {
      const { type: _type, ...data } = projectedEvent.uiEvent;
      return { type: projectedEvent.type, data: withDefined(data) };
    }
    case "interaction.resolved": {
      const { type: _type, ...data } = projectedEvent.uiEvent;
      return { type: projectedEvent.type, data: withDefined(data) };
    }
  }
}
