export interface RunCleanupSnapshot {
  readonly confirmed: boolean;
  readonly settled?: Promise<void>;
}

/** Physical tool ownership can outlive the result returned to the model. */
export class RunCleanupTracker {
  private readonly pending = new Map<string, Set<Promise<void>>>();

  begin(runId: string | undefined): {
    report(state: "in-progress" | "unconfirmed" | "confirmed"): void;
    settle(release?: () => void | Promise<void>): void;
  } {
    const key = runId ?? "";
    let resolve!: () => void;
    const completion = new Promise<void>((done) => {
      resolve = done;
    });
    let rawSettled = false;
    let released = false;
    let cleanup: "in-progress" | "unconfirmed" | "confirmed" | undefined;
    {
      const entries = this.pending.get(key) ?? new Set();
      entries.add(completion);
      this.pending.set(key, entries);
    }
    const confirm = (): void => {
      if (
        !rawSettled ||
        !released ||
        (cleanup !== undefined && cleanup !== "confirmed")
      )
        return;
      {
        const entries = this.pending.get(key);
        entries?.delete(completion);
        if (entries?.size === 0) this.pending.delete(key);
      }
      resolve();
    };
    return {
      report(state): void {
        cleanup = state;
        confirm();
      },
      settle(release): void {
        rawSettled = true;
        if (!release) {
          released = true;
          confirm();
          return;
        }
        void Promise.resolve()
          .then(release)
          .then(
            () => {
              released = true;
              confirm();
            },
            () => {
              // The caller reports release errors. Absence of proof retains ownership.
            },
          );
      },
    };
  }

  snapshot(runId?: string): RunCleanupSnapshot {
    const entries =
      runId === undefined
        ? [...this.pending.values()].flatMap((items) => [...items])
        : [...(this.pending.get(runId) ?? [])];
    return entries.length
      ? {
          confirmed: false,
          settled: Promise.all(entries).then(() => undefined),
        }
      : { confirmed: true };
  }
}
