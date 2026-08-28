import type { UiCommandRecord, UiCommandRecorder } from "ohbaby-sdk";

const DEFAULT_CAPACITY = 256;

export interface StructuredUiCommandRecorderOptions {
  readonly capacity?: number;
  readonly sink: (record: UiCommandRecord) => Promise<void> | void;
  readonly onDiagnostic?: (error: unknown) => void;
}

export interface StructuredUiCommandRecorder extends UiCommandRecorder {
  flush(): Promise<void>;
}

const NOOP_DIAGNOSTIC = (): void => undefined;

function assertExplicitSink(
  options: unknown,
): asserts options is StructuredUiCommandRecorderOptions {
  const candidate = options as { readonly sink?: unknown } | null | undefined;
  if (typeof candidate?.sink !== "function") {
    throw new TypeError("UI command recorder sink must be a function");
  }
}

class BoundedStructuredUiCommandRecorder implements StructuredUiCommandRecorder {
  private readonly capacity: number;
  private readonly onDiagnostic: (error: unknown) => void;
  private readonly queue: UiCommandRecord[] = [];
  private readonly sink: (record: UiCommandRecord) => Promise<void> | void;
  private flushPromise: Promise<void> | undefined;
  private flushScheduled = false;

  constructor(options: StructuredUiCommandRecorderOptions) {
    assertExplicitSink(options);
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new TypeError(
        "UI command recorder capacity must be a positive integer",
      );
    }
    this.capacity = capacity;
    this.onDiagnostic = options.onDiagnostic ?? NOOP_DIAGNOSTIC;
    this.sink = options.sink;
  }

  record(entry: UiCommandRecord): void {
    if (this.queue.length >= this.capacity) {
      throw new Error("UI command recorder queue is full");
    }
    this.queue.push(entry);
    this.scheduleFlush();
  }

  flush(): Promise<void> {
    if (this.flushPromise !== undefined) {
      return this.flushPromise;
    }
    if (this.queue.length === 0) {
      return Promise.resolve();
    }
    this.flushScheduled = false;
    const work = this.drain();
    this.flushPromise = work.finally(() => {
      this.flushPromise = undefined;
      if (this.queue.length > 0) {
        this.scheduleFlush();
      }
    });
    return this.flushPromise;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const entry = this.queue.shift();
      if (entry === undefined) {
        return;
      }
      try {
        await this.sink(entry);
      } catch (error) {
        try {
          this.onDiagnostic(error);
        } catch {
          // Recorder diagnostics must not recurse into the business path.
        }
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.flushPromise !== undefined) {
      return;
    }
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }
}

export function createStructuredUiCommandRecorder(
  options: StructuredUiCommandRecorderOptions,
): StructuredUiCommandRecorder {
  return new BoundedStructuredUiCommandRecorder(options);
}
