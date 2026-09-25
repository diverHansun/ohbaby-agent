import type { UiEvent, UiUnsubscribe } from "ohbaby-sdk";

export interface EventEnvelope {
  readonly event: UiEvent;
  readonly seqNum: number;
}

export type EventBusReplayResult =
  | {
      readonly envelopes: readonly EventEnvelope[];
      readonly kind: "ok";
    }
  | {
      readonly kind: "resync-required";
      readonly maxSeqNum: number;
      readonly minSeqNum: number;
    };

export interface EventBusOptions {
  readonly capacity?: number;
  readonly maxBytes?: number;
}

export type EventEnvelopeHandler = (envelope: EventEnvelope) => void;

const DEFAULT_CAPACITY = 1_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export class EventBus {
  private readonly buffer: EventEnvelope[] = [];
  private readonly capacity: number;
  private readonly maxBytes: number;
  private readonly sizes: number[] = [];
  private retainedBytes = 0;
  private readonly subscribers = new Set<EventEnvelopeHandler>();
  private nextSeqNum = 1;

  constructor(options: EventBusOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("EventBus capacity must be a positive integer");
    }
    this.capacity = capacity;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("EventBus maxBytes must be a positive safe integer");
    }
    this.maxBytes = maxBytes;
  }

  get latestSeqNum(): number {
    return this.nextSeqNum - 1;
  }

  get minSeqNum(): number | undefined {
    return this.buffer[0]?.seqNum;
  }

  publish(event: UiEvent): EventEnvelope {
    const envelope = {
      event,
      seqNum: this.nextSeqNum,
    };
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    this.nextSeqNum += 1;
    this.buffer.push(envelope);
    this.sizes.push(bytes);
    this.retainedBytes += bytes;
    // The wire-size budget bounds cumulative streaming payload retention as well
    // as count. A single oversized event is delivered live, but requires a view
    // query for a reconnecting consumer instead of an incomplete replay.
    while (
      this.buffer.length > this.capacity ||
      this.retainedBytes > this.maxBytes
    ) {
      this.buffer.shift();
      this.retainedBytes -= this.sizes.shift() ?? 0;
    }
    for (const subscriber of Array.from(this.subscribers)) {
      subscriber(envelope);
    }
    return envelope;
  }

  replayAfter(seqNum: number): EventBusReplayResult {
    const latestSeqNum = this.latestSeqNum;
    if (seqNum > latestSeqNum) {
      return {
        kind: "resync-required",
        maxSeqNum: latestSeqNum,
        minSeqNum: this.minSeqNum ?? 0,
      };
    }

    const minSeqNum = this.minSeqNum;
    if (minSeqNum === undefined) {
      if (seqNum < latestSeqNum) {
        return {
          kind: "resync-required",
          maxSeqNum: latestSeqNum,
          minSeqNum: latestSeqNum + 1,
        };
      }
      return { envelopes: [], kind: "ok" };
    }
    if (seqNum < minSeqNum - 1) {
      return {
        kind: "resync-required",
        maxSeqNum: latestSeqNum,
        minSeqNum,
      };
    }
    return {
      envelopes: this.buffer.filter((envelope) => envelope.seqNum > seqNum),
      kind: "ok",
    };
  }

  subscribe(handler: EventEnvelopeHandler): UiUnsubscribe {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }
}
