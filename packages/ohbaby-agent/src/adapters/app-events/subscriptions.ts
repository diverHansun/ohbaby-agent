import type {
  BusEventDefinition,
  BusEventPayload,
  BusInstance,
  BusUnsubscribe,
} from "../../bus/index.js";
import {
  appEventProjectors,
  type AppEventProjector,
  type AppProjectedEventType,
  type ProjectedAppEvent,
} from "./projectors.js";

export interface AppEventProjectorError {
  readonly eventType: string;
  readonly error: unknown;
}

type AppEventProjectorTarget = <Type extends AppProjectedEventType>(
  event: ProjectedAppEvent<Type>,
) => void;

export interface SubscribeAppEventProjectorsOptions {
  readonly bus: BusInstance;
  readonly target: AppEventProjectorTarget;
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
    subscribeProjector(bus, target, onError, commandStarted),
    subscribeProjector(bus, target, onError, commandResultDelivered),
    subscribeProjector(bus, target, onError, commandFailed),
    subscribeProjector(bus, target, onError, commandCatalogUpdated),
    subscribeProjector(bus, target, onError, interactionRequested),
    subscribeProjector(bus, target, onError, interactionResolved),
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
  target: AppEventProjectorTarget,
  onError: ((error: AppEventProjectorError) => void) | undefined,
  projector: AppEventProjector<Event, Type>,
): BusUnsubscribe {
  return bus.subscribe(projector.event, (payload: BusEventPayload<Event>) => {
    try {
      target(projector.project(payload));
    } catch (error) {
      onError?.({ eventType: projector.event.type, error });
      throw error;
    }
  });
}
