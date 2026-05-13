import type { BusEventDefinition, BusEventPayload } from "./bus-event.js";

export type BusUnsubscribe = () => void;

export type BusCallback<Event extends BusEventDefinition> = (
  payload: BusEventPayload<Event>,
) => void;

export interface BusSubscriberError {
  readonly eventType: string;
  readonly error: unknown;
}

export interface BusOptions {
  readonly onSubscriberError?: (error: BusSubscriberError) => void;
}

export interface BusInstance {
  publish<Event extends BusEventDefinition>(
    event: Event,
    payload: BusEventPayload<Event>,
  ): void;
  subscribe<Event extends BusEventDefinition>(
    event: Event,
    callback: BusCallback<Event>,
  ): BusUnsubscribe;
}
