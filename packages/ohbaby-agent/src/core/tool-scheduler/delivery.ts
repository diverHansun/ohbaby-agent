import type {
  BatchToolCallObserver,
  ToolCallRequest,
  ToolCallResult,
  ToolExecutionObservation,
} from "./types.js";

export class ToolDeliveryError extends Error {
  override readonly name = "ToolDeliveryError";
  constructor(cause: unknown) {
    super("Tool observation could not be delivered", { cause });
  }
}

/** One original owner retains this chain for late cleanup, even after batch return. */
export class CallDelivery {
  private pending: Promise<void> = Promise.resolve();
  private terminal = false;
  private published = false;
  private failureReported = false;
  state: ToolExecutionObservation;
  constructor(
    private readonly request: ToolCallRequest,
    private readonly index: number,
    private readonly observer: BatchToolCallObserver,
    private readonly fail: (
      error: ToolDeliveryError,
      state: ToolExecutionObservation,
    ) => void,
    now: number,
  ) {
    this.state = {
      runId: request.runId,
      phase: "preparing",
      phaseStartedAt: now,
      createdAt: now,
    };
  }
  private enqueue(
    commit: () => Promise<void>,
    observation: ToolExecutionObservation,
  ): Promise<void> {
    this.pending = this.pending.then(commit).catch((cause: unknown) => {
      const error =
        cause instanceof ToolDeliveryError
          ? cause
          : new ToolDeliveryError(cause);
      if (!this.failureReported) {
        this.failureReported = true;
        this.fail(error, observation);
      }
      throw error;
    });
    void this.pending.catch(() => undefined);
    return this.pending;
  }
  update(patch: Partial<ToolExecutionObservation>): Promise<void> {
    if (this.terminal && patch.cleanup === undefined) return this.pending;
    const changedPhase =
      patch.phase !== undefined &&
      (patch.phase !== this.state.phase ||
        patch.waitReason !== this.state.waitReason);
    const next = this.terminal
      ? { ...this.state, cleanup: patch.cleanup }
      : {
          ...this.state,
          ...(patch.phase !== undefined
            ? {
                waitReason: undefined,
                blockingCallIds: undefined,
                predecessorsKnown: undefined,
              }
            : {}),
          ...patch,
          phaseStartedAt: changedPhase
            ? (patch.phaseStartedAt ?? this.state.phaseStartedAt)
            : this.state.phaseStartedAt,
        };
    if (JSON.stringify(next) === JSON.stringify(this.state) && this.published)
      return this.pending;
    this.published = true;
    this.state = next;
    return this.enqueue(
      () => this.observer.onCallState(this.request, next),
      next,
    );
  }
  flush(): Promise<void> {
    return this.pending;
  }
  settle(result: ToolCallResult, now: number): Promise<void> {
    if (this.terminal) return this.pending;
    this.terminal = true;
    this.state = {
      ...this.state,
      phase: "ended",
      phaseStartedAt: now,
      endedAt: now,
      waitReason: undefined,
      blockingCallIds: undefined,
      predecessorsKnown: undefined,
      outcome:
        result.error?.type === "TimeoutError"
          ? "timed-out"
          : (result.executionOutcome ?? result.status),
    };
    const delivered = { ...result, execution: this.state };
    return this.enqueue(
      () => this.observer.onCallSettled(this.request, this.index, delivered),
      this.state,
    );
  }
}
