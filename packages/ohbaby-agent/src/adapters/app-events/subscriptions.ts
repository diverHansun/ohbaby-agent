import type { BusInstance, BusUnsubscribe } from "../../bus/index.js";
import {
  appEventProjectors,
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
  const unsubscribers = appEventProjectors.map((projector) =>
    bus.subscribe(projector.event, (payload) => {
      try {
        target(projector.project(payload as never) as ProjectedAppEvent);
      } catch (error) {
        onError?.({ eventType: projector.event.type, error });
      }
    }),
  );

  return () => {
    for (const unsubscribe of unsubscribers.splice(0)) {
      unsubscribe();
    }
  };
}
