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
}

export type EventEnvelopeHandler = (envelope: EventEnvelope) => void;

const DEFAULT_CAPACITY = 1_000;

export class EventBus {
  private readonly buffer: EventEnvelope[] = [];
  private readonly capacity: number;
  private readonly subscribers = new Set<EventEnvelopeHandler>();
  private nextSeqNum = 1;

  constructor(options: EventBusOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("EventBus capacity must be a positive integer");
    }
    this.capacity = capacity;
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
    this.nextSeqNum += 1;
    this.buffer.push(envelope);
    while (this.buffer.length > this.capacity) {
      this.buffer.shift();
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
