import type { SubmitPromptOptions } from "ohbaby-sdk";

const FRESH_SESSION_LANE = "__fresh__";
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 2_000;

export interface DaemonPromptQueueItem {
  readonly clientId: string;
  readonly sessionId?: string;
  readonly text: string;
  readonly options?: SubmitPromptOptions;
}

export interface DaemonPromptQueueOptions {
  readonly submit: (item: DaemonPromptQueueItem) => Promise<void>;
  readonly isBusyError?: (error: unknown) => boolean;
  readonly retryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
}

interface QueueEntry {
  readonly item: DaemonPromptQueueItem;
  readonly lane: string;
  resolve(): void;
  reject(error: unknown): void;
}

export class DaemonPromptQueueShutdownError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DaemonPromptQueueShutdownError";
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

function laneForItem(item: DaemonPromptQueueItem): string {
  return item.sessionId ?? FRESH_SESSION_LANE;
}

export class DaemonPromptQueue {
  private readonly activeLanes = new Set<string>();
  private readonly queue: QueueEntry[] = [];
  private closedReason: string | undefined;
  private draining = false;

  constructor(private readonly options: DaemonPromptQueueOptions) {}

  get size(): number {
    return this.queue.length;
  }

  enqueue(item: DaemonPromptQueueItem): Promise<void> {
    if (this.closedReason) {
      return Promise.reject(
        new DaemonPromptQueueShutdownError(this.closedReason),
      );
    }

    const promise = new Promise<void>((resolve, reject) => {
      this.queue.push({
        item,
        lane: laneForItem(item),
        resolve,
        reject,
      });
    });
    this.drain();
    return promise;
  }

  disconnectClient(_clientId: string): void {
    return undefined;
  }

  shutdown(reason: string): void {
    if (this.closedReason) {
      return;
    }
    this.closedReason = reason;
    const error = new DaemonPromptQueueShutdownError(reason);
    for (const entry of this.queue.splice(0)) {
      entry.reject(error);
    }
  }

  private drain(): void {
    if (this.draining || this.closedReason) {
      return;
    }
    this.draining = true;
    try {
      for (;;) {
        const index = this.queue.findIndex(
          (entry) => !this.activeLanes.has(entry.lane),
        );
        if (index < 0) {
          return;
        }
        const [entry] = this.queue.splice(index, 1);
        this.activeLanes.add(entry.lane);
        void this.runEntry(entry);
      }
    } finally {
      this.draining = false;
    }
  }

  private async runEntry(entry: QueueEntry): Promise<void> {
    let retryDelayMs = this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const maxRetryDelayMs =
      this.options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    const isBusyError = this.options.isBusyError ?? ((): boolean => false);

    try {
      for (;;) {
        try {
          await this.options.submit(entry.item);
          entry.resolve();
          return;
        } catch (error) {
          if (!isBusyError(error)) {
            entry.reject(error);
            return;
          }
          await delay(retryDelayMs);
          retryDelayMs = Math.min(
            Math.max(retryDelayMs * 2, retryDelayMs),
            maxRetryDelayMs,
          );
        }
      }
    } finally {
      this.activeLanes.delete(entry.lane);
      this.drain();
    }
  }
}
