export type StreamScope = "app" | `run/${string}`;

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface StreamEvent<TData = JsonValue> {
  readonly id: number;
  readonly scope: StreamScope;
  readonly event: string;
  readonly data: TData;
}

export interface StreamGapData {
  readonly scope: StreamScope;
  readonly runId?: string;
  readonly requestedLastEventId: number;
  readonly oldestRetainedEventId: number;
  readonly latestEventId: number;
  readonly reason: "buffer-overflow";
}

export type StreamGapEvent = StreamEvent<StreamGapData> & {
  readonly event: "stream.gap";
};

export type StreamBridgeEvent = StreamEvent | StreamGapEvent;

export const HEARTBEAT_SENTINEL = Symbol("stream.heartbeat");
export const END_SENTINEL = Symbol("stream.end");

export type StreamBridgeYield = StreamBridgeEvent | typeof HEARTBEAT_SENTINEL;

export interface StreamBridge {
  publish(scope: StreamScope, event: string, data: unknown): number;
  subscribe(
    scope: StreamScope,
    lastEventId?: number,
  ): AsyncIterable<StreamBridgeYield>;
  end(scope: StreamScope): void;
}

export interface InMemoryStreamBridgeOptions {
  readonly capacity?: number;
  readonly heartbeatIntervalMs?: number;
}
