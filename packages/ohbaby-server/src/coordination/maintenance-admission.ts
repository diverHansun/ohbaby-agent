import { createShutdownOptions, withinShutdown } from "ohbaby-agent";

export const MAINTENANCE_ADMISSION_MESSAGE =
  "The daemon is checking for active work before stopping. Try again shortly.";

/** Pausing admissions leaves existing tasks and their result streams intact. */
export class MaintenanceAdmission {
  private readonly pending = new Set<Promise<void>>();
  private paused = false;

  get isPaused(): boolean {
    return this.paused;
  }

  tryEnter(): (() => void) | undefined {
    if (this.paused) return undefined;
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.pending.add(pending);
    return () => {
      this.pending.delete(pending);
      complete();
    };
  }

  async check(
    requestSignal: AbortSignal,
    getReasons: () => Promise<readonly string[]>,
    accept: () => boolean,
  ): Promise<readonly string[]> {
    if (this.paused) return ["A daemon shutdown check is already in progress."];
    this.paused = true;
    let accepted = false;
    const timeout = createShutdownOptions(5_000);
    const signal = AbortSignal.any([requestSignal, timeout.signal]);
    try {
      const reasons = await withinShutdown(
        { ...timeout, signal },
        "Idle shutdown check",
        async () => {
          await Promise.all(this.pending);
          signal.throwIfAborted();
          return getReasons();
        },
      );
      signal.throwIfAborted();
      if (reasons.length) return reasons;
      accepted = accept();
      return accepted ? [] : ["The daemon is already stopping."];
    } catch (error) {
      return [
        signal.aborted || Date.now() >= timeout.deadlineAt
          ? "The idle shutdown check timed out or was canceled. Try again."
          : `Unable to check daemon activity: ${error instanceof Error ? error.message : String(error)}`,
      ];
    } finally {
      if (!accepted) this.paused = false;
    }
  }
}
