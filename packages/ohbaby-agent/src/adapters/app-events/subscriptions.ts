import type {
  BusEventDefinition,
  BusEventPayload,
  BusInstance,
  BusUnsubscribe,
} from "../../bus/index.js";
import {
  appEventProjectors,
  type AppProjectedEventType,
  type ProjectedAppEvent,
} from "./projectors.js";

export interface AppEventProjectorError {
  readonly eventType: string;
  readonly error: unknown;
}

export interface SubscribeAppEventProjectorsOptions {
  readonly bus: BusInstance;
  readonly target: (event: ProjectedAppEvent) => void;
  readonly onError?: (error: AppEventProjectorError) => void;
}

export function subscribeAppEventProjectors({
  bus,
  target,
  onError,
}: SubscribeAppEventProjectorsOptions): BusUnsubscribe {
  const [
    commandStarted,
    commandResultDelivered,
    commandFailed,
    commandCatalogUpdated,
    interactionRequested,
    interactionResolved,
  ] = appEventProjectors;
  const unsubscribers = [
    subscribeProjector(
      bus,
      target,
      onError,
      commandStarted.event,
      (payload) => commandStarted.project(payload),
    ),
    subscribeProjector(
      bus,
      target,
      onError,
      commandResultDelivered.event,
      (payload) => commandResultDelivered.project(payload),
    ),
    subscribeProjector(
      bus,
      target,
      onError,
      commandFailed.event,
      (payload) => commandFailed.project(payload),
    ),
    subscribeProjector(
      bus,
      target,
      onError,
      commandCatalogUpdated.event,
      (payload) => commandCatalogUpdated.project(payload),
    ),
    subscribeProjector(
      bus,
      target,
      onError,
      interactionRequested.event,
      (payload) => interactionRequested.project(payload),
    ),
    subscribeProjector(
      bus,
      target,
      onError,
      interactionResolved.event,
      (payload) => interactionResolved.project(payload),
    ),
  ];

  return () => {
    for (const unsubscribe of unsubscribers.splice(0)) {
      unsubscribe();
    }
  };
}

function subscribeProjector<
  Event extends BusEventDefinition,
  Type extends AppProjectedEventType,
>(
  bus: BusInstance,
  target: (event: ProjectedAppEvent) => void,
  onError: ((error: AppEventProjectorError) => void) | undefined,
  event: Event,
  project: (payload: BusEventPayload<Event>) => ProjectedAppEvent<Type>,
): BusUnsubscribe {
  return bus.subscribe(event, (payload) => {
    try {
      target(project(payload) as unknown as ProjectedAppEvent);
    } catch (error) {
      onError?.({ eventType: event.type, error });
      throw error;
    }
  });
}
