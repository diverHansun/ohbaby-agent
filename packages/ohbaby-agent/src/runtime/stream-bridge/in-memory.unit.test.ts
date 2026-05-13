import { describe, expect, it } from "vitest";
import { createInMemoryStreamBridge, HEARTBEAT_SENTINEL } from "./index.js";

async function nextEvent(
  iterable: AsyncIterable<unknown>,
): Promise<IteratorResult<unknown>> {
  return iterable[Symbol.asyncIterator]().next();
}

describe("InMemoryStreamBridge", () => {
  it("assigns event ids independently per scope", () => {
    const bridge = createInMemoryStreamBridge();

    expect(bridge.publish("app", "runtime.updated", { status: "idle" })).toBe(
      1,
    );
    expect(
      bridge.publish("run/run_1", "run.updated", { status: "running" }),
    ).toBe(1);
    expect(bridge.publish("app", "command.started", { id: "cmd_1" })).toBe(2);
  });

  it("pushes only new events for a fresh subscription", async () => {
    const bridge = createInMemoryStreamBridge();
    bridge.publish("app", "old.event", { ignored: true });

    const subscription = bridge.subscribe("app");
    bridge.publish("app", "new.event", { value: 1 });

    await expect(nextEvent(subscription)).resolves.toMatchObject({
      done: false,
      value: {
        id: 2,
        scope: "app",
        event: "new.event",
        data: { value: 1 },
      },
    });
  });

  it("replays retained events after the provided last event id", async () => {
    const bridge = createInMemoryStreamBridge({ capacity: 3 });
    bridge.publish("app", "one", { value: 1 });
    bridge.publish("app", "two", { value: 2 });
    bridge.publish("app", "three", { value: 3 });

    const iterator = bridge.subscribe("app", 1)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: 2, event: "two", data: { value: 2 } },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: 3, event: "three", data: { value: 3 } },
    });

    bridge.publish("app", "four", { value: 4 });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: 4, event: "four", data: { value: 4 } },
    });
  });

  it("handles continuous reconnect at latest id and oldest retained boundary", async () => {
    const latestBridge = createInMemoryStreamBridge({ capacity: 2 });
    latestBridge.publish("app", "one", { value: 1 });
    latestBridge.publish("app", "two", { value: 2 });
    latestBridge.publish("app", "three", { value: 3 });

    const fromLatest = latestBridge.subscribe("app", 3)[Symbol.asyncIterator]();
    latestBridge.publish("app", "four", { value: 4 });
    await expect(fromLatest.next()).resolves.toMatchObject({
      done: false,
      value: { id: 4, event: "four" },
    });
    await fromLatest.return?.();

    const boundaryBridge = createInMemoryStreamBridge({ capacity: 2 });
    boundaryBridge.publish("app", "one", { value: 1 });
    boundaryBridge.publish("app", "two", { value: 2 });
    boundaryBridge.publish("app", "three", { value: 3 });

    const fromBoundary = boundaryBridge
      .subscribe("app", 1)
      [Symbol.asyncIterator]();
    await expect(fromBoundary.next()).resolves.toMatchObject({
      done: false,
      value: { id: 2, event: "two" },
    });
    await expect(fromBoundary.next()).resolves.toMatchObject({
      done: false,
      value: { id: 3, event: "three" },
    });
    await fromBoundary.return?.();
  });

  it("emits a stream.gap event without consuming a new event id", async () => {
    const bridge = createInMemoryStreamBridge({ capacity: 2 });
    bridge.publish("app", "one", { value: 1 });
    bridge.publish("app", "two", { value: 2 });
    bridge.publish("app", "three", { value: 3 });

    const iterator = bridge.subscribe("app", 0)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        id: 3,
        scope: "app",
        event: "stream.gap",
        data: {
          scope: "app",
          requestedLastEventId: 0,
          oldestRetainedEventId: 2,
          latestEventId: 3,
          reason: "buffer-overflow",
        },
      },
    });

    expect(bridge.publish("app", "four", { value: 4 })).toBe(4);
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: 4, event: "four", data: { value: 4 } },
    });
  });

  it("includes runId in stream.gap data for run scopes", async () => {
    const bridge = createInMemoryStreamBridge({ capacity: 1 });
    bridge.publish("run/run_1", "one", { value: 1 });
    bridge.publish("run/run_1", "two", { value: 2 });

    const iterator = bridge.subscribe("run/run_1", 0)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        event: "stream.gap",
        data: {
          scope: "run/run_1",
          runId: "run_1",
          requestedLastEventId: 0,
          oldestRetainedEventId: 2,
          latestEventId: 2,
        },
      },
    });
    await iterator.return?.();
  });

  it("rejects invalid last event ids instead of resuming from the wrong point", () => {
    const bridge = createInMemoryStreamBridge();
    bridge.publish("app", "one", { value: 1 });

    expect(() => bridge.subscribe("app", -1)).toThrow(/lastEventId/);
    expect(() => bridge.subscribe("app", 1.5)).toThrow(/lastEventId/);
    expect(() => bridge.subscribe("app", 999)).toThrow(/lastEventId/);
  });

  it("drops queued replay events after end", async () => {
    const bridge = createInMemoryStreamBridge();
    bridge.publish("app", "one", { value: 1 });
    bridge.publish("app", "two", { value: 2 });

    const iterator = bridge.subscribe("app", 0)[Symbol.asyncIterator]();
    bridge.end("app");

    const result = await iterator.next();
    expect(result.done).toBe(true);
  });

  it("completes active subscriptions when a scope ends", async () => {
    const bridge = createInMemoryStreamBridge();
    const iterator = bridge.subscribe("run/run_1")[Symbol.asyncIterator]();

    bridge.end("run/run_1");

    const result = await iterator.next();
    expect(result.done).toBe(true);
  });

  it("stops queued events after the consumer returns early", async () => {
    const bridge = createInMemoryStreamBridge();
    const iterator = bridge.subscribe("app")[Symbol.asyncIterator]();

    bridge.publish("app", "one", { value: 1 });
    await iterator.return?.();
    bridge.publish("app", "two", { value: 2 });

    const result = await iterator.next();
    expect(result.done).toBe(true);
  });

  it("bounds slow subscriber backlog by sending a stream.gap", async () => {
    const bridge = createInMemoryStreamBridge({ capacity: 2 });
    const iterator = bridge.subscribe("app")[Symbol.asyncIterator]();

    bridge.publish("app", "one", { value: 1 });
    bridge.publish("app", "two", { value: 2 });
    bridge.publish("app", "three", { value: 3 });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        id: 3,
        event: "stream.gap",
        data: {
          requestedLastEventId: 0,
          oldestRetainedEventId: 2,
          latestEventId: 3,
        },
      },
    });
  });

  it("publishes new events to every active subscriber", async () => {
    const bridge = createInMemoryStreamBridge();
    const first = bridge.subscribe("app")[Symbol.asyncIterator]();
    const second = bridge.subscribe("app")[Symbol.asyncIterator]();

    bridge.publish("app", "one", { value: 1 });

    await expect(first.next()).resolves.toMatchObject({
      done: false,
      value: { id: 1, event: "one" },
    });
    await expect(second.next()).resolves.toMatchObject({
      done: false,
      value: { id: 1, event: "one" },
    });
    await first.return?.();
    await second.return?.();
  });

  it("sends heartbeat sentinels to idle subscribers", async () => {
    const bridge = createInMemoryStreamBridge({ heartbeatIntervalMs: 1 });
    const iterator = bridge.subscribe("app")[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: HEARTBEAT_SENTINEL,
    });
    await iterator.return?.();
  });

  it("rejects non-json payloads without advancing event id", () => {
    const bridge = createInMemoryStreamBridge();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => {
      bridge.publish("app", "bad.event", circular);
    }).toThrow(/JSON serializable/);
    expect(bridge.publish("app", "good.event", { ok: true })).toBe(1);
  });

  it("rejects payload values that JSON would silently coerce or omit", () => {
    const bridge = createInMemoryStreamBridge();

    expect(() => bridge.publish("app", "bad", { value: undefined })).toThrow(
      /JSON serializable/,
    );
    expect(() =>
      bridge.publish("app", "bad", { value: () => undefined }),
    ).toThrow(/JSON serializable/);
    expect(() =>
      bridge.publish("app", "bad", { value: Symbol("nope") }),
    ).toThrow(/JSON serializable/);
    expect(() => bridge.publish("app", "bad", { value: Number.NaN })).toThrow(
      /JSON serializable/,
    );
    expect(() => bridge.publish("app", "bad", { value: Infinity })).toThrow(
      /JSON serializable/,
    );
    expect(() => bridge.publish("app", "bad", Symbol("nope"))).toThrow(
      /JSON serializable/,
    );
    expect(bridge.publish("app", "good", { ok: true })).toBe(1);
  });

  it("allows shared object references that are still valid JSON", async () => {
    const bridge = createInMemoryStreamBridge();
    const shared = { value: 1 };

    bridge.publish("app", "shared", { first: shared, second: shared });

    const iterator = bridge.subscribe("app", 0)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        data: {
          first: { value: 1 },
          second: { value: 1 },
        },
      },
    });
    await iterator.return?.();
  });

  it("snapshots payloads at publish time", async () => {
    const bridge = createInMemoryStreamBridge();
    const payload = { nested: { value: 1 } };

    bridge.publish("app", "one", payload);
    payload.nested.value = 2;

    const iterator = bridge.subscribe("app", 0)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { data: { nested: { value: 1 } } },
    });
  });
});
