import type { ConcurrencyConfig, ToolCategory } from "./types.js";

export interface QueuedSlot {
  readonly callId: string;
  readonly category: ToolCategory;
  readonly resolve: (acquired: boolean) => void;
}

function isReadLike(category: ToolCategory): boolean {
  return (
    category === "readonly" || category === "network" || category === "skill"
  );
}

function isWriteLike(category: ToolCategory): boolean {
  return category === "write" || category === "dangerous";
}

export class ConcurrencyController {
  private readingCount = 0;
  private writeInProgress = false;
  private subagentCount = 0;
  private readonly queue: QueuedSlot[] = [];

  constructor(private readonly config: ConcurrencyConfig) {}

  canExecute(category: ToolCategory): boolean {
    if (category === "memory") {
      return true;
    }
    if (category === "subagent") {
      return this.subagentCount < this.config.maxSubagentConcurrency;
    }
    if (isReadLike(category)) {
      return (
        !this.writeInProgress &&
        this.readingCount < this.config.maxReadConcurrency
      );
    }
    if (isWriteLike(category)) {
      return !this.writeInProgress && this.readingCount === 0;
    }

    return false;
  }

  acquire(category: ToolCategory): void {
    if (category === "subagent") {
      this.subagentCount += 1;
    } else if (isReadLike(category)) {
      this.readingCount += 1;
    } else if (isWriteLike(category)) {
      this.writeInProgress = true;
    }
  }

  release(category: ToolCategory): void {
    if (category === "subagent") {
      this.subagentCount = Math.max(0, this.subagentCount - 1);
    } else if (isReadLike(category)) {
      this.readingCount = Math.max(0, this.readingCount - 1);
    } else if (isWriteLike(category)) {
      this.writeInProgress = false;
    }
    this.processQueue();
  }

  waitForSlot(callId: string, category: ToolCategory): Promise<boolean> {
    const shouldRespectQueuedWrite =
      isReadLike(category) &&
      this.queue.some((slot) => isWriteLike(slot.category));
    if (!shouldRespectQueuedWrite && this.canExecute(category)) {
      this.acquire(category);
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      this.queue.push({ callId, category, resolve });
    });
  }

  cancel(callId: string): boolean {
    const index = this.queue.findIndex((item) => item.callId === callId);
    if (index === -1) {
      return false;
    }
    const [slot] = this.queue.splice(index, 1);
    slot.resolve(false);
    this.processQueue();
    return true;
  }

  cancelAll(): string[] {
    const callIds = this.queue.map((item) => item.callId);
    while (this.queue.length > 0) {
      const slot = this.queue.shift();
      slot?.resolve(false);
    }
    return callIds;
  }

  private hasEarlierWriteBarrier(index: number): boolean {
    return this.queue
      .slice(0, index)
      .some((slot) => isWriteLike(slot.category));
  }

  private processQueue(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let index = 0; index < this.queue.length; index += 1) {
        const slot = this.queue[index];
        if (isReadLike(slot.category) && this.hasEarlierWriteBarrier(index)) {
          continue;
        }
        if (!this.canExecute(slot.category)) {
          continue;
        }
        this.queue.splice(index, 1);
        this.acquire(slot.category);
        slot.resolve(true);
        progressed = true;
        break;
      }
    }
  }
}
