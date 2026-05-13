import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BusEvent, createBus } from "./index.js";
import type { BusEventPayload } from "./index.js";

describe("Bus", () => {
  it("publishes typed payloads to every matching subscriber", () => {
    const bus = createBus();
    const event = BusEvent.define(
      "test.updated",
      z.object({ value: z.number() }),
    );
    const received: number[] = [];

    bus.subscribe(event, (payload) => {
      received.push(payload.value);
    });
    bus.subscribe(event, (payload) => {
      received.push(payload.value * 2);
    });

    bus.publish(event, { value: 21 });

    expect(received).toEqual([21, 42]);
  });

  it("stops delivering events after unsubscribe", () => {
    const bus = createBus();
    const event = BusEvent.define(
      "test.changed",
      z.object({ value: z.string() }),
    );
    const received: string[] = [];
    const unsubscribe = bus.subscribe(event, (payload) => {
      received.push(payload.value);
    });

    bus.publish(event, { value: "before" });
    unsubscribe();
    bus.publish(event, { value: "after" });

    expect(received).toEqual(["before"]);
  });

  it("validates payloads before notifying subscribers", () => {
    const bus = createBus();
    const event = BusEvent.define(
      "test.validated",
      z.object({ value: z.number() }),
    );
    const received: number[] = [];
    bus.subscribe(event, (payload) => {
      received.push(payload.value);
    });

    const invalidPayload = { value: "wrong" } as unknown as BusEventPayload<
      typeof event
    >;

    expect(() => {
      bus.publish(event, invalidPayload);
    }).toThrow();

    expect(received).toEqual([]);
  });

  it("isolates subscriber errors and continues notifying later subscribers", () => {
    const errors: unknown[] = [];
    const bus = createBus({
      onSubscriberError(error) {
        errors.push(error);
      },
    });
    const event = BusEvent.define(
      "test.error-isolated",
      z.object({ value: z.number() }),
    );
    const received: number[] = [];

    bus.subscribe(event, () => {
      throw new Error("subscriber failed");
    });
    bus.subscribe(event, (payload) => {
      received.push(payload.value);
    });

    expect(() => {
      bus.publish(event, { value: 7 });
    }).not.toThrow();
    expect(received).toEqual([7]);
    expect(errors).toHaveLength(1);
  });

  it("isolates subscriber error handlers that also fail", () => {
    const bus = createBus({
      onSubscriberError() {
        throw new Error("logger failed");
      },
    });
    const event = BusEvent.define(
      "test.error-handler-isolated",
      z.object({ value: z.number() }),
    );
    const received: number[] = [];

    bus.subscribe(event, () => {
      throw new Error("subscriber failed");
    });
    bus.subscribe(event, (payload) => {
      received.push(payload.value);
    });

    expect(() => {
      bus.publish(event, { value: 11 });
    }).not.toThrow();
    expect(received).toEqual([11]);
  });
});
