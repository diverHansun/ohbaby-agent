# T33 getSnapshot run-ledger probe

## Path and scope

- `createInProcessUiBackendClient().getSnapshot()` calls `readSnapshotWithPermission()` (`packages/ohbaby-agent/src/adapters/ui-inprocess.ts:3876`). That first calls `stateStore.readSnapshot()` (`:1820`), then calls `sourceLedger.get(run.id)` once for every run returned by the state store (`:1869-1875`).
- The persistent state store includes at most 50 recent active primary sessions by default (`packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts:44,445-463`), plus the selected active session if needed. It calls `runLedger.listBySession(session.id)` once per included session **without a run limit** (`:432-440`), so the run count can grow with all history for those sessions. The database list is one `SELECT ... WHERE session_id = ? ORDER BY created_at DESC` (`packages/ohbaby-agent/src/runtime/run-ledger/database.ts:544-558`); each later `get` is a separate `SELECT ... WHERE run_id = ?` (`:169-173,538-542`). Other sessions outside the included set do not add runs to this snapshot.
- This is the explicit legacy `getSnapshot` path. The recovery view uses bounded reads (`packages/ohbaby-agent/src/adapters/ui-inprocess.ts:681,760`), so the finding should not be generalized to every entry path.

## Controlled measurement

`snapshot-history-probe.mts` creates a disposable SQLite database under the OS temp directory, seeds one session and 1,000 succeeded runs, and removes the database after the run. It calls the real in-process backend, the real SQLite run ledger, and (in the persistent pass) the real persistent UI state store. Only the session and message manager inputs are lightweight in-process fixtures; no LLM or user database is used. A database wrapper counts statement preparation, row `get`, and `all`; a ledger wrapper counts `get` and `listBySession`. Each size has three warmups and 15 timed `getSnapshot` calls, with median wall time from `performance.now()`. The smaller sizes in the persistent pass use a limited list wrapper to vary returned history while keeping the real SQL query.

Command: `pnpm exec tsx docs/problem-lists/2026-09-19-execution-reliability/improve-4.1/evidence/2026-09-29/snapshot-history-probe.mts` (Node 26.3.1, local macOS host). Results from the final run:

| View | Returned runs | Ledger list / snapshot | Ledger get / snapshot | SQLite prepare / snapshot | SQLite row get / snapshot | Median ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| In-memory snapshot + SQLite ledger | 0 | 0 | 0 | 0 | 0 | 0.006 |
| In-memory snapshot + SQLite ledger | 10 | 0 | 10 | 10 | 10 | 0.109 |
| In-memory snapshot + SQLite ledger | 100 | 0 | 100 | 100 | 100 | 1.044 |
| In-memory snapshot + SQLite ledger | 500 | 0 | 500 | 500 | 500 | 5.143 |
| In-memory snapshot + SQLite ledger | 1,000 | 0 | 1,000 | 1,000 | 1,000 | 10.262 |
| Persistent store + SQLite ledger | 10 | 1 | 10 | 11 | 10 | 0.171 |
| Persistent store + SQLite ledger | 1,000 | 1 | 1,000 | 1,001 | 1,000 | 11.485 |

The persistent rows also performed one SQLite `all` per snapshot. Query count is thus `S` list queries plus `N` point lookups, where `S` is included sessions and `N` is all returned historical runs across them. The data confirms linear growth in this isolated setup. It does not measure end-to-end Web startup, production-sized messages, multiple sessions, cache behavior across processes, or real-world run-history distribution. Median milliseconds are local observations, not an acceptance threshold.

## Judgment

The per-run lookup is real and measurable, but this fixture alone does not establish a user-visible regression or typical cost. T33's stated rule is to measure before optimizing and avoid a machine-dependent millisecond gate. Under KISS, no product code change is warranted solely from this result. If real user histories show large included run counts or startup delay, a targeted batch projection can be evaluated against this baseline; retain the distinction between full-history legacy snapshots and bounded recovery reads.
