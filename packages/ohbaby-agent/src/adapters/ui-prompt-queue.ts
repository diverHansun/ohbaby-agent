import type { SubmitPromptOptions } from "ohbaby-sdk";

export interface PromptQueueItem {
  readonly text: string;
  readonly sessionId: string | null;
  readonly submitOptions?: SubmitPromptOptions;
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
  private readonly queue: QueueEntry[] = [];
  private closed = false;
  private draining = false;

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

  close(): void {
    this.closed = true;
    const error = new PromptQueueClosedError();
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
    for (;;) {
      try {
        await this.options.submit(entry.item);
        entry.resolve();
        return;
      } catch (error) {
        if (!this.options.isBusyError(error) || this.closed) {
          entry.reject(error);
          return;
        }
        await delay(this.options.retryDelayMs);
      }
    }
  }
}
