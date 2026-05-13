import { createBus } from "./bus.js";
import type { BusInstance } from "./types.js";

export { BusEvent } from "./bus-event.js";
export { createBus } from "./bus.js";
export type { BusEventDefinition, BusEventPayload } from "./bus-event.js";
export type {
  BusInstance,
  BusCallback,
  BusOptions,
  BusSubscriberError,
  BusUnsubscribe,
} from "./types.js";

export const Bus: BusInstance = createBus();
