import type { InterfaceProviderStreamEvent } from "../../services/interface-providers/types.js";
import type { ModelRequestObservation, ModelRequestRecord } from "./types.js";

export class ModelObservationError extends Error {
  constructor(cause: unknown) {
    super(
      `Model observations could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "ModelObservationError";
  }
}
/** Capture facts at receipt; serialize only the three durable transitions. */
export class RequestAttemptObserver {
  private tail: Promise<void> = Promise.resolve();
  private facts: ModelRequestObservation[] = [];
  private started = false;
  private failure?: ModelObservationError;
  private resolveStart!: () => void;
  private readonly startSignal = new Promise<void>((resolve) => {
    this.resolveStart = resolve;
  });
  private finishedAt?: number;
  constructor(
    private record: ModelRequestRecord | undefined,
    private readonly save?: (fact: ModelRequestObservation) => Promise<void>,
    private readonly signal?: AbortSignal,
  ) {
    signal?.addEventListener("abort", this.onAbort, { once: true });
  }
  private readonly onAbort = (): void => {
    this.end("aborted");
  };
  close(): void {
    this.signal?.removeEventListener("abort", this.onAbort);
  }
  receivedError(): void {
    this.finishedAt ??= Date.now();
  }
  async receive<T>(pending: Promise<T>): Promise<T | { error: unknown }> {
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<{ error: unknown }>((resolve) => {
      onAbort = (): void => {
        this.onAbort();
        resolve({ error: this.signal?.reason ?? new Error("Request aborted") });
      };
      this.signal?.addEventListener("abort", onAbort, { once: true });
      if (this.signal?.aborted) onAbort();
    });
    try {
      return await Promise.race([pending, aborted]);
    } finally {
      if (onAbort) this.signal?.removeEventListener("abort", onAbort);
    }
  }
  start(): void {
    this.started = true;
    if (this.record) {
      this.record = { ...this.record, startedAt: Date.now() };
      this.enqueue("request-started");
    }
    this.resolveStart();
  }
  async waitStarted(opening: Promise<unknown>): Promise<void> {
    await Promise.race([this.startSignal, opening]);
  }
  next(
    iterator: AsyncIterator<InterfaceProviderStreamEvent> | undefined,
  ): Promise<
    IteratorResult<InterfaceProviderStreamEvent> | { error: unknown }
  > {
    if (!iterator)
      return Promise.reject(new Error("Provider iterator was not initialized"));
    return this.receive(
      iterator.next().then(
        (next) => {
          if (next.done) this.finishedAt = Date.now();
          else if (
            next.value.textDelta &&
            this.record &&
            this.record.firstTextAt === undefined &&
            this.record.endedAt === undefined
          ) {
            this.record = { ...this.record, firstTextAt: Date.now() };
            this.enqueue("first-text");
          }
          return next;
        },
        (error: unknown) => {
          this.finishedAt = Date.now();
          return { error };
        },
      ),
    );
  }
  end(outcome: "success" | "error" | "aborted"): void {
    if (!this.started || !this.record || this.record.endedAt !== undefined)
      return;
    this.record = {
      ...this.record,
      endedAt: this.finishedAt ?? Date.now(),
      outcome,
    };
    this.enqueue("request-ended");
  }
  private enqueue(type: ModelRequestObservation["type"]): void {
    if (!this.record) return;
    const fact = { type, request: this.record };
    const persist = async (): Promise<void> => {
      if (this.failure) return;
      try {
        await this.save?.(fact);
        this.facts.push(fact);
      } catch (error) {
        this.failure = new ModelObservationError(error);
      }
    };
    // Invoke the initial callback now, without delaying actual adapter I/O.
    this.tail =
      type === "request-started" ? persist() : this.tail.then(persist);
  }
  async flush(): Promise<void> {
    await this.tail;
    if (this.failure) throw this.failure;
  }
  drain(): ModelRequestObservation[] {
    const result = this.facts;
    this.facts = [];
    return result;
  }
}
