import type { BusEventDefinition, BusEventPayload } from "./bus-event.js";
import type {
  BusInstance,
  BusCallback,
  BusOptions,
  BusSubscriberError,
  BusUnsubscribe,
} from "./types.js";

type UntypedCallback = (payload: unknown) => void;

export function createBus(options: BusOptions = {}): BusInstance {
  const subscriptions = new Map<string, Set<UntypedCallback>>();

  function publish<Event extends BusEventDefinition>(
    event: Event,
    payload: BusEventPayload<Event>,
  ): void {
    const parsedPayload = event.schema.parse(payload) as BusEventPayload<Event>;
    const callbacks = Array.from(subscriptions.get(event.type) ?? []);

    for (const callback of callbacks) {
      try {
        callback(parsedPayload);
      } catch (error) {
        const subscriberError: BusSubscriberError = {
          eventType: event.type,
          error,
        };
        try {
          options.onSubscriberError?.(subscriberError);
        } catch {
          // Error reporting must not break event isolation.
        }
      }
    }
  }

  function subscribe<Event extends BusEventDefinition>(
    event: Event,
    callback: BusCallback<Event>,
  ): BusUnsubscribe {
    const callbacks =
      subscriptions.get(event.type) ?? new Set<UntypedCallback>();
    callbacks.add(callback);
    subscriptions.set(event.type, callbacks);

    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        subscriptions.delete(event.type);
      }
    };
  }

  return { publish, subscribe };
}
