import type { SubmitPromptOptions } from "ohbaby-sdk";

export interface PromptQueueItem {
  readonly text: string;
  readonly sessionId: string | null;
  readonly submitOptions?: SubmitPromptOptions;
  readonly useActiveSessionOnDrain?: boolean;
}

export type PromptQueueSubmit = (item: PromptQueueItem) => Promise<void>;

export interface PromptQueueOptions {
  readonly submit: PromptQueueSubmit;
  readonly isBusyError: (error: unknown) => boolean;
  readonly retryDelayMs: number;
}

interface QueueEntry {
  readonly item: PromptQueueItem;
  resolve(): void;
  reject(error: unknown): void;
}

export class PromptQueueClosedError extends Error {
  constructor() {
    super("Prompt queue is closed");
    this.name = "PromptQueueClosedError";
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class PromptQueueController {
  private activeEntry: QueueEntry | undefined;
  private readonly queue: QueueEntry[] = [];
  private closed = false;
  private draining = false;
  private retryingEntry: QueueEntry | undefined;

  constructor(private readonly options: PromptQueueOptions) {}

  enqueue(item: PromptQueueItem): Promise<void> {
    if (this.closed) {
      return Promise.reject(new PromptQueueClosedError());
    }

    const promise = new Promise<void>((resolve, reject) => {
      this.queue.push({ item, resolve, reject });
    });
    void this.drain();
    return promise;
  }

  size(): number {
    return this.queue.length;
  }

  hasPendingWork(): boolean {
    return (
      this.activeEntry !== undefined ||
      this.queue.length > 0 ||
      this.retryingEntry !== undefined
    );
  }

  close(): void {
    this.closed = true;
    const error = new PromptQueueClosedError();
    this.retryingEntry?.reject(error);
    this.retryingEntry = undefined;
    for (const entry of this.queue.splice(0)) {
      entry.reject(error);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      for (;;) {
        if (this.closed) {
          return;
        }
        const entry = this.queue.shift();
        if (!entry) {
          return;
        }
        await this.submitWithBusyRetry(entry);
      }
    } finally {
      this.draining = false;
    }
  }

  private async submitWithBusyRetry(entry: QueueEntry): Promise<void> {
    this.activeEntry = entry;
    try {
      for (;;) {
        if (this.rejectIfClosed(entry)) {
          return;
        }
        try {
          await this.options.submit(entry.item);
          this.activeEntry = undefined;
          entry.resolve();
          return;
        } catch (error) {
          if (this.rejectIfClosed(entry)) {
            return;
          }
          if (!this.options.isBusyError(error)) {
            this.activeEntry = undefined;
            entry.reject(error);
            return;
          }
          this.retryingEntry = entry;
          await delay(this.options.retryDelayMs);
          if (this.retryingEntry === entry) {
            this.retryingEntry = undefined;
          }
          if (this.rejectIfClosed(entry)) {
            return;
          }
        }
      }
    } finally {
      if (this.activeEntry === entry) {
        this.activeEntry = undefined;
      }
    }
  }

  private rejectIfClosed(entry: QueueEntry): boolean {
    if (!this.closed) {
      return false;
    }
    entry.reject(new PromptQueueClosedError());
    return true;
  }
}
