import type { ConcurrencyConfig } from "./types.js";

/** Assigned by the scheduler from trusted tool capabilities, never by category. */
export type CapacityKind = "ordinary" | "dispatch" | "control";

export interface CapacityLease {
  /** Returns this acquisition once; late completion/cancellation may call it again. */
  release(): void;
}

interface QueuedSlot {
  readonly callId: string;
  readonly kind: CapacityKind;
  readonly sessionId: string;
  readonly resolve: (lease: CapacityLease | undefined) => void;
}

interface SessionCapacity {
  ordinary: number;
  dispatch: number;
}

export class ConcurrencyController {
  private readonly sessions = new Map<string, SessionCapacity>();
  private readonly queue: QueuedSlot[] = [];
  private readonly availabilityListeners = new Set<() => void>();
  private readonly ordinaryLimit: number;
  private readonly dispatchLimit: number;

  constructor(config: ConcurrencyConfig) {
    for (const [name, limit] of Object.entries(config)) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
    this.ordinaryLimit =
      config.maxConcurrency ?? config.maxReadConcurrency ?? 10;
    this.dispatchLimit = config.maxSubagentConcurrency;
  }

  canExecute(kind: CapacityKind, sessionId: string): boolean {
    return (
      this.hasRoom(kind, sessionId) &&
      !this.queue.some(
        (slot) => slot.kind === kind && slot.sessionId === sessionId,
      )
    );
  }

  tryAcquire(kind: CapacityKind, sessionId: string): CapacityLease | undefined {
    if (!this.canExecute(kind, sessionId)) {
      return undefined;
    }
    return this.createLease(kind, sessionId);
  }

  acquire(kind: CapacityKind, sessionId: string): CapacityLease {
    const lease = this.tryAcquire(kind, sessionId);
    if (!lease) {
      throw new Error(`No ${kind} capacity available for session`);
    }
    return lease;
  }

  waitForSlot(
    callId: string,
    kind: CapacityKind,
    sessionId: string,
  ): Promise<CapacityLease | undefined> {
    const lease = this.tryAcquire(kind, sessionId);
    if (lease) {
      return Promise.resolve(lease);
    }
    return new Promise((resolve) => {
      this.queue.push({ callId, kind, sessionId, resolve });
    });
  }

  /** Re-evaluate joint resource/capacity admission after a slot is returned. */
  subscribeAvailability(listener: () => void): () => void {
    this.availabilityListeners.add(listener);
    return () => this.availabilityListeners.delete(listener);
  }

  cancel(callId: string): boolean {
    const index = this.queue.findIndex((item) => item.callId === callId);
    if (index === -1) {
      return false;
    }
    const [slot] = this.queue.splice(index, 1);
    slot.resolve(undefined);
    return true;
  }

  cancelAll(): string[] {
    const slots = this.queue.splice(0);
    for (const slot of slots) {
      slot.resolve(undefined);
    }
    return slots.map((slot) => slot.callId);
  }

  private hasRoom(kind: CapacityKind, sessionId: string): boolean {
    if (kind === "control") {
      return true;
    }
    const count = this.sessions.get(sessionId)?.[kind] ?? 0;
    return (
      count < (kind === "ordinary" ? this.ordinaryLimit : this.dispatchLimit)
    );
  }

  private createLease(kind: CapacityKind, sessionId: string): CapacityLease {
    if (kind === "control") {
      return {
        release(): void {
          // Control capabilities consume no capacity.
        },
      };
    }
    const counts = this.sessions.get(sessionId) ?? { ordinary: 0, dispatch: 0 };
    this.sessions.set(sessionId, counts);
    counts[kind] += 1;
    let released = false;
    return {
      release: (): void => {
        if (released) {
          return;
        }
        released = true;
        counts[kind] -= 1;
        if (counts.ordinary === 0 && counts.dispatch === 0) {
          this.sessions.delete(sessionId);
        }
        this.processQueue();
        for (const listener of this.availabilityListeners) {
          listener();
        }
      },
    };
  }

  private processQueue(): void {
    for (let index = 0; index < this.queue.length; ) {
      const slot = this.queue[index];
      if (!this.hasRoom(slot.kind, slot.sessionId)) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      slot.resolve(this.createLease(slot.kind, slot.sessionId));
    }
  }
}
