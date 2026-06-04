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
  // The readonly projector table is a tuple of distinct projector functions.
  // Widen each entry at the subscription boundary so map can iterate the table
  // without rebuilding the same list by hand.
  const unsubscribers = appEventProjectors.map((projector) =>
    subscribeProjector(
      bus,
      target,
      onError,
      projector as AppEventProjector,
    ),
  );

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
  projector: AppEventProjector<Event, Type>,
): BusUnsubscribe {
  return bus.subscribe(projector.event, (payload: BusEventPayload<Event>) => {
    try {
      target(projector.project(payload) as unknown as ProjectedAppEvent);
    } catch (error) {
      onError?.({ eventType: projector.event.type, error });
      throw error;
    }
  });
}
