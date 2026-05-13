import { RingBuffer } from "./ring-buffer.js";
import type {
  InMemoryStreamBridgeOptions,
  JsonValue,
  StreamBridge,
  StreamBridgeEvent,
  StreamBridgeYield,
  StreamEvent,
  StreamGapData,
  StreamGapEvent,
  StreamScope,
} from "./types.js";
import { END_SENTINEL, HEARTBEAT_SENTINEL } from "./types.js";

interface BufferedEvent {
  readonly scope: StreamScope;
  readonly event: string;
  readonly data: JsonValue;
}

interface ScopeState {
  readonly buffer: RingBuffer<BufferedEvent>;
  readonly subscribers: Set<StreamSubscription>;
}

type ReplayPlan =
  | {
      readonly kind: "gap";
      readonly requestedLastEventId: number;
      readonly reason: StreamGapData["reason"];
    }
  | {
      readonly kind: "replay";
      readonly fromId: number;
      readonly toId: number;
    };

function toStreamEvent(entry: {
  readonly id: number;
  readonly data: BufferedEvent;
}): StreamEvent {
  return {
    id: entry.id,
    scope: entry.data.scope,
    event: entry.data.event,
    data: entry.data.data,
  };
}

function runIdFromScope(scope: StreamScope): string | undefined {
  return scope.startsWith("run/") ? scope.slice("run/".length) : undefined;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateJsonValue(data: unknown, seen = new WeakSet<object>()): void {
  if (data === null) {
    return;
  }

  switch (typeof data) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(data)) {
        throw new TypeError("Stream payload must be JSON serializable");
      }
      return;
    case "object":
      break;
    default:
      throw new TypeError("Stream payload must be JSON serializable");
  }

  if (seen.has(data)) {
    throw new TypeError("Stream payload must be JSON serializable");
  }
  seen.add(data);

  if (Array.isArray(data)) {
    for (let index = 0; index < data.length; index += 1) {
      if (!(index in data)) {
        throw new TypeError("Stream payload must be JSON serializable");
      }
      validateJsonValue(data[index], seen);
    }
    seen.delete(data);
    return;
  }

  if (!isPlainObject(data) || Object.getOwnPropertySymbols(data).length > 0) {
    throw new TypeError("Stream payload must be JSON serializable");
  }

  for (const value of Object.values(data)) {
    validateJsonValue(value, seen);
  }
  seen.delete(data);
}

function cloneJsonSerializable(data: unknown): JsonValue {
  validateJsonValue(data);

  try {
    return JSON.parse(JSON.stringify(data)) as JsonValue;
  } catch (error) {
    throw new TypeError("Stream payload must be JSON serializable", {
      cause: error,
    });
  }
}

function validateLastEventId(lastEventId: number): void {
  if (!Number.isInteger(lastEventId) || lastEventId < 0) {
    throw new RangeError("lastEventId must be a retained non-negative integer");
  }
}

class StreamSubscription implements AsyncIterableIterator<StreamBridgeYield> {
  private readonly queue: StreamBridgeYield[] = [];
  private readonly waiting: ((
    result: IteratorResult<StreamBridgeYield>,
  ) => void)[] = [];
  private closed = false;
  private ending = false;
  private readonly heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly onClose: () => void,
    private readonly maxQueueSize: number,
    private readonly createGapEvent: (
      requestedLastEventId: number,
    ) => StreamGapEvent,
    private lastDeliveredEventId: number,
    heartbeatIntervalMs: number,
  ) {
    if (heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.pushHeartbeat();
      }, heartbeatIntervalMs);
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<StreamBridgeYield> {
    return this;
  }

  next(): Promise<IteratorResult<StreamBridgeYield>> {
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }

    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(this.deliver(queued));
    }

    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  return(): Promise<IteratorResult<StreamBridgeYield>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  push(event: StreamBridgeEvent): void {
    if (this.closed || this.ending) {
      return;
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter(this.deliver(event));
      return;
    }

    if (this.queue.length >= this.maxQueueSize) {
      this.queue.splice(0);
      this.queue.push(this.createGapEvent(this.lastDeliveredEventId));
      return;
    }

    this.queue.push(event);
  }

  pushHeartbeat(): void {
    if (this.closed || this.ending || this.queue.length > 0) {
      return;
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ done: false, value: HEARTBEAT_SENTINEL });
    }
  }

  pushEnd(): void {
    if (this.closed || this.ending) {
      return;
    }

    this.ending = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    const waiter = this.waiting.shift();
    if (waiter && this.queue.length === 0) {
      waiter(this.deliver(END_SENTINEL));
      return;
    }

    this.queue.push(END_SENTINEL);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.queue.splice(0);
    this.finish();
  }

  private deliver(event: StreamBridgeYield): IteratorResult<StreamBridgeYield> {
    if (event === END_SENTINEL) {
      this.finish();
      return { done: false, value: event };
    }

    this.markDelivered(event);
    return { done: false, value: event };
  }

  private finish(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.onClose();

    for (const waiter of this.waiting.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  private markDelivered(event: StreamBridgeYield): void {
    if (event !== HEARTBEAT_SENTINEL && event !== END_SENTINEL) {
      this.lastDeliveredEventId = event.id;
    }
  }
}

class ClosedStreamSubscription implements AsyncIterableIterator<StreamBridgeYield> {
  private delivered = false;

  [Symbol.asyncIterator](): AsyncIterableIterator<StreamBridgeYield> {
    return this;
  }

  next(): Promise<IteratorResult<StreamBridgeYield>> {
    if (this.delivered) {
      return Promise.resolve({ done: true, value: undefined });
    }

    this.delivered = true;
    return Promise.resolve({ done: false, value: END_SENTINEL });
  }

  return(): Promise<IteratorResult<StreamBridgeYield>> {
    this.delivered = true;
    return Promise.resolve({ done: true, value: undefined });
  }
}

export class InMemoryStreamBridge implements StreamBridge {
  private readonly capacity: number;
  private readonly heartbeatIntervalMs: number;
  private readonly scopes = new Map<StreamScope, ScopeState>();
  private readonly endedScopes = new Set<StreamScope>();

  constructor(options: InMemoryStreamBridgeOptions = {}) {
    this.capacity = options.capacity ?? 100;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  }

  publish(scope: StreamScope, event: string, data: unknown): number {
    const jsonData = cloneJsonSerializable(data);

    this.endedScopes.delete(scope);
    const state = this.getScopeState(scope);
    const entry = state.buffer.append({ scope, event, data: jsonData });
    const streamEvent = toStreamEvent(entry);

    for (const subscriber of state.subscribers) {
      subscriber.push(streamEvent);
    }

    return entry.id;
  }

  subscribe(
    scope: StreamScope,
    lastEventId?: number,
  ): AsyncIterable<StreamBridgeYield> {
    if (this.endedScopes.has(scope)) {
      return new ClosedStreamSubscription();
    }
    if (
      lastEventId === undefined &&
      scope.startsWith("run/") &&
      !this.scopes.has(scope)
    ) {
      return new ClosedStreamSubscription();
    }

    const state = this.getScopeState(scope);
    if (lastEventId !== undefined) {
      validateLastEventId(lastEventId);
    }

    const initialLastDeliveredEventId = lastEventId ?? state.buffer.latestId;
    const subscription = new StreamSubscription(
      () => {
        state.subscribers.delete(subscription);
      },
      this.capacity,
      (requestedLastEventId) =>
        this.createGapEvent(scope, state, requestedLastEventId),
      initialLastDeliveredEventId,
      this.heartbeatIntervalMs,
    );
    state.subscribers.add(subscription);

    if (lastEventId !== undefined) {
      this.enqueueReplayOrGap(scope, state, subscription, lastEventId);
    }

    return subscription;
  }

  end(scope: StreamScope): void {
    this.endedScopes.add(scope);
    const state = this.scopes.get(scope);
    if (!state) {
      return;
    }

    for (const subscriber of Array.from(state.subscribers)) {
      subscriber.pushEnd();
    }
    this.scopes.delete(scope);
  }

  private getScopeState(scope: StreamScope): ScopeState {
    const existing = this.scopes.get(scope);
    if (existing) {
      return existing;
    }

    const state = {
      buffer: new RingBuffer<BufferedEvent>(this.capacity),
      subscribers: new Set<StreamSubscription>(),
    };
    this.scopes.set(scope, state);
    return state;
  }

  private enqueueReplayOrGap(
    scope: StreamScope,
    state: ScopeState,
    subscription: StreamSubscription,
    lastEventId: number,
  ): void {
    const plan = this.getReplayPlan(state, lastEventId);
    if (plan.kind === "gap") {
      subscription.push(
        this.createGapEvent(
          scope,
          state,
          plan.requestedLastEventId,
          plan.reason,
        ),
      );
      return;
    }

    for (const entry of state.buffer.getRange(plan.fromId, plan.toId)) {
      subscription.push(toStreamEvent(entry));
    }
  }

  private getReplayPlan(state: ScopeState, lastEventId: number): ReplayPlan {
    if (lastEventId > state.buffer.latestId) {
      return {
        kind: "gap",
        requestedLastEventId: lastEventId,
        reason: "bridge-restarted",
      };
    }

    if (!state.buffer.isContinuous(lastEventId)) {
      return {
        kind: "gap",
        requestedLastEventId: lastEventId,
        reason: "buffer-overflow",
      };
    }

    return {
      kind: "replay",
      fromId: lastEventId + 1,
      toId: state.buffer.latestId,
    };
  }

  private createGapEvent(
    scope: StreamScope,
    state: ScopeState,
    lastEventId: number,
    reason: StreamGapData["reason"] = "buffer-overflow",
  ): StreamGapEvent {
    const data: StreamGapData = {
      scope,
      requestedLastEventId: lastEventId,
      oldestRetainedEventId: state.buffer.oldestId,
      latestEventId: state.buffer.latestId,
      reason,
    };
    const runId = runIdFromScope(scope);

    return {
      id: state.buffer.latestId,
      scope,
      event: "stream.gap",
      data: runId === undefined ? data : { ...data, runId },
    };
  }
}

export function createInMemoryStreamBridge(
  options?: InMemoryStreamBridgeOptions,
): StreamBridge {
  return new InMemoryStreamBridge(options);
}
