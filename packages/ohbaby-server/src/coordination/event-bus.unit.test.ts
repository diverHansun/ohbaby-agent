import { describe, expect, it, vi } from "vitest";
import type { UiEvent } from "ohbaby-sdk";
import { EventBus } from "./event-bus.js";

const timestamp = "2026-06-12T00:00:00.000Z";

function notice(id: string): UiEvent {
  return {
    notice: {
      createdAt: timestamp,
      id,
      level: "info",
      message: `Notice ${id}`,
      title: `Notice ${id}`,
    },
    type: "notice.emitted",
  };
}

describe("EventBus", () => {
  it("bounds retained bytes independently of event count and asks old cursors to resync", () => {
    const event = notice("long".repeat(100));
    const size = Buffer.byteLength(JSON.stringify({ event, seqNum: 1 }));
    const bus = new EventBus({ capacity: 1000, maxBytes: size + 1 });
    bus.publish(event);
    bus.publish(event);
    expect(bus.replayAfter(0).kind).toBe("resync-required");
    expect(bus.replayAfter(1)).toMatchObject({
      kind: "ok",
      envelopes: [{ seqNum: 2 }],
    });
  });
  it("delivers oversized live events without retaining them or claiming a complete replay", () => {
    const bus = new EventBus({ maxBytes: 1 });
    const received = vi.fn();
    bus.subscribe(received);
    bus.publish(notice("oversized"));
    expect(received).toHaveBeenCalledOnce();
    expect(bus.replayAfter(0).kind).toBe("resync-required");
    expect(bus.replayAfter(1)).toEqual({ kind: "ok", envelopes: [] });
    expect(bus.minSeqNum).toBeUndefined();
  });
  it("assigns monotonic sequence numbers to published events", () => {
    const bus = new EventBus({ capacity: 10 });

    expect(bus.publish(notice("one"))).toEqual({
      event: notice("one"),
      seqNum: 1,
    });
    expect(bus.publish(notice("two"))).toEqual({
      event: notice("two"),
      seqNum: 2,
    });
    expect(bus.latestSeqNum).toBe(2);
  });

  it("replays only events after the provided cursor", () => {
    const bus = new EventBus({ capacity: 10 });
    bus.publish(notice("one"));
    bus.publish(notice("two"));
    bus.publish(notice("three"));

    expect(bus.replayAfter(1)).toEqual({
      envelopes: [
        { event: notice("two"), seqNum: 2 },
        { event: notice("three"), seqNum: 3 },
      ],
      kind: "ok",
    });
  });

  it("returns resync-required when the cursor is outside the retained window", () => {
    const bus = new EventBus({ capacity: 2 });
    bus.publish(notice("one"));
    bus.publish(notice("two"));
    bus.publish(notice("three"));

    expect(bus.replayAfter(0)).toEqual({
      kind: "resync-required",
      maxSeqNum: 3,
      minSeqNum: 2,
    });
  });

  it("returns resync-required when the cursor is ahead of the latest event", () => {
    const bus = new EventBus({ capacity: 10 });

    expect(bus.replayAfter(1)).toEqual({
      kind: "resync-required",
      maxSeqNum: 0,
      minSeqNum: 0,
    });

    bus.publish(notice("one"));
    bus.publish(notice("two"));

    expect(bus.replayAfter(99)).toEqual({
      kind: "resync-required",
      maxSeqNum: 2,
      minSeqNum: 1,
    });
  });

  it("notifies realtime subscribers and stops after unsubscribe", () => {
    const bus = new EventBus({ capacity: 10 });
    const handler = vi.fn();

    const unsubscribe = bus.subscribe(handler);
    const first = bus.publish(notice("one"));
    unsubscribe();
    bus.publish(notice("two"));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(first);
  });
});
