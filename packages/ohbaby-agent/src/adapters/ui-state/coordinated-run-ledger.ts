import {
  RunLedgerNotFoundError,
  type RunLedger,
  type RunLedgerRecord,
} from "../../runtime/run-ledger/index.js";

export interface RunCommitCoordinator {
  run<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  onCommitted(record: RunLedgerRecord): void;
  onProjectionError(sessionId: string, error: unknown): void;
}

/** Run facts are accepted with their session version before ordinary notifications. */
export function createCoordinatedRunLedger(options: {
  readonly ledger: RunLedger;
  readonly coordinator: RunCommitCoordinator;
}): RunLedger {
  const { ledger, coordinator } = options;
  const projectionError = (sessionId: string, error: unknown): void => {
    try {
      coordinator.onProjectionError(sessionId, error);
    } catch {
      /* An observer cannot change an already durable run transition. */
    }
  };
  const accept = (record: RunLedgerRecord): void => {
    try {
      coordinator.onCommitted(structuredClone(record));
    } catch (error) {
      projectionError(record.sessionId, error);
    }
  };
  const transition = async (
    runId: string,
    operation: () => Promise<RunLedgerRecord>,
  ): Promise<RunLedgerRecord> => {
    // A run's session identity cannot change. The mutation and its acceptance
    // are queued together; this preliminary lookup creates no recovery effects.
    const record = await ledger.get(runId);
    if (!record) throw new RunLedgerNotFoundError(runId);
    return coordinator.run(record.sessionId, async () => {
      const updated = await operation();
      accept(updated);
      return updated;
    });
  };
  return {
    runtimeInputMemory: ledger.runtimeInputMemory,
    createPending: (input) =>
      coordinator.run(input.sessionId, async () => {
        const record = await ledger.createPending(input);
        accept(record);
        return record;
      }),
    claimPendingRun: (input) =>
      coordinator.run(input.sessionId, async () => {
        // claim may also recover orphaned runs in this same scope, even if a
        // different active owner subsequently causes the claim to be rejected.
        const before = (await ledger.getActiveRuns(input.sessionId)).filter(
          (record) => record.contextScopeId === input.contextScopeId,
        );
        let claimed: RunLedgerRecord;
        try {
          claimed = await ledger.claimPendingRun(input);
        } finally {
          for (const previous of before) {
            try {
              const current = await ledger.get(previous.runId);
              if (current && current.status !== previous.status)
                accept(current);
            } catch (error) {
              projectionError(input.sessionId, error);
            }
          }
        }
        accept(claimed);
        return claimed;
      }),
    markRunning: (runId) => transition(runId, () => ledger.markRunning(runId)),
    markSucceeded: (runId, terminal) =>
      transition(runId, () => ledger.markSucceeded(runId, terminal)),
    markFailed: (runId, error, errorData, terminal) =>
      transition(runId, () =>
        ledger.markFailed(runId, error, errorData, terminal),
      ),
    markCancelled: (runId, reason, terminal) =>
      transition(runId, () => ledger.markCancelled(runId, reason, terminal)),
    markRunInterrupted: (runId, reason, terminal) =>
      transition(runId, () =>
        ledger.markRunInterrupted(runId, reason, terminal),
      ),
    // Explicit startup recovery precedes session view initialization. These
    // existing global operations are deliberately not runtime mutation APIs:
    // they cannot claim a per-session cut after changing every session at once.
    markInterrupted: (input) => ledger.markInterrupted(input),
    recoverOrphanedRuns: (options) => ledger.recoverOrphanedRuns(options),
    get: (runId) => ledger.get(runId),
    listBySession: (sessionId, input) => ledger.listBySession(sessionId, input),
    getActiveRuns: (sessionId) => ledger.getActiveRuns(sessionId),
  };
}
