# Terminal Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make terminal startup/session ownership deterministic, prevent same-session concurrent runs, queue prompts ergonomically, and prepare the runtime for daemon-backed terminal/Web/App frontends.

**Architecture:** Phase 1 keeps the production path in-process but adds terminal-view isolation, process-local prompt FIFO, and database-backed session run claiming. Phase 2 reduces risk by splitting the current large in-process UI backend into focused modules. Phase 3 adds an explicit daemon protocol. Phase 4 makes the daemon the default coordinator and moves strict cross-terminal FIFO into the daemon.

**Tech Stack:** TypeScript, pnpm, Vitest, Ink TUI, SQLite-backed persistent store, existing ohbaby-agent runtime managers, existing real-provider smoke tests through root `.env`.

---

## Confirmed Product Semantics

- Default `pnpm start` opens a fresh terminal view with no active session selected.
- Default startup must not create an empty session.
- The first prompt in a fresh terminal creates a real session only when the prompt is submitted.
- Explicit `--resume <sessionId>` opens that session.
- A new `--continue` option may reopen the latest primary session explicitly.
- Within one terminal process, prompts for the same visible session use FIFO queueing.
- If a prompt is running and the user double-presses `Esc`, the running prompt is interrupted and the next queued prompt in that terminal automatically starts.
- Phase 1 stores queued prompts only in the current terminal process memory.
- If the terminal process exits, unsent queued prompts are lost.
- Phase 1 prevents same-session concurrent runs across processes with database-backed session claiming, but it does not guarantee strict cross-terminal FIFO.
- Strict cross-terminal FIFO is a Phase 4 daemon responsibility.
- ACP and A2A are not Phase 1-3 dependencies. The internal backend/client contract should stay protocol-neutral so ACP can be added later as an adapter if an external editor or agent ecosystem needs it.
- Queue semantics confirmed 2026-06-12 (supersedes the earlier reject-on-busy default in `02-solution-design.md` 3.5; docs 02/04 have been synced). The ledger claim still throws `SessionRunBusyError` for cross-process mutual exclusion; the local queue consumes that error and retries, so TUI users see a queued state instead of an error.
- This plan is the Phase 1-4 roadmap. Phase 1 is specified at implementation depth; Phases 3-4 are outline-level and must be expanded into their own detailed task lists (same format as Phase 1) before each phase starts.

## Current Failure Mode To Preserve In Tests

Two terminal windows currently read the same persisted `activeSessionId` from `app_state`, so both enter the same session. Each process has its own `promptInFlight`, so both can submit. Rendering is local to each process, but DB history can become interleaved. Local sequential run IDs such as `run_1` can collide across processes, and `snapshotStatus` can report another session's active run because it scans all active runs.

The important hidden edge case is in `packages/ohbaby-agent/src/core/agents/runner.ts`: the initial user message is written before the run is created. If a database session claim rejects the run after that point, the implementation can leave a ghost user message. Phase 1 must test and fix that.

## Branch And Commit Policy

- [ ] Each phase gets its own temporary branch cut from `mvp` (confirmed: one branch per phase, not a single long-lived branch):

```powershell
git switch mvp
git switch -c feat/terminal-daemon-phase-1   # phase-2/3/4 likewise, after the previous phase merges
```

- [ ] Commit per completed task (or small task group) on the phase branch — Phase 1 touches ~25 files and must not land as a single commit. Follow the repo's scoped commit convention (`fix(agent): ...`, `feat(tui): ...`, `refactor(agent): ...`).
- [ ] Merge the phase branch back into `mvp` only after unit, integration, relevant e2e/smoke, and subagent review have all passed.
- [ ] Do not commit `.env`, generated secrets, or real-provider outputs.
- [ ] Keep the existing staged docs under `docs/problem-lists/terminal-daemon/` intact unless the user explicitly asks to squash or reorganize them.

## Verification Commands Used After Each Phase

Run the narrow targeted tests first, then the broader gates:

```powershell
pnpm run typecheck
pnpm run lint
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm test:e2e:snapshot
pnpm test:smoke:real
pnpm run build
```

`pnpm test:smoke:real` loads root `.env` and requires `ZAI_API_KEY` or `ZHIPU_API_KEY`. Do not print API key values in logs or review notes.

After each phase, request a code review subagent focused on that phase's files and tests. The review prompt should ask for race conditions, data-loss risks, test gaps, and accidental behavior changes.

---

## Phase 1: Terminal Isolation, Local Queue, And Session Claim

**Outcome:** A new terminal starts blank without creating a session. Prompts in one terminal queue locally. Same-session concurrent runs across processes are blocked by an atomic claim. Double-`Esc` interruption drains the next queued prompt automatically.

### File Structure

Modify:

- `packages/ohbaby-agent/src/adapters/ui-state/types.ts` - clarify active-session persistence contract.
- `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts` - stop default startup from adopting DB `activeSessionId`; filter status to the selected session.
- `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.unit.test.ts` - unit coverage for default blank view and status filtering.
- `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.integration.test.ts` - SQLite coverage for app-state compatibility and no empty-session creation.
- `packages/ohbaby-agent/src/adapters/ui-persistent.ts` - apply startup session policy for default, `--resume`, and `--continue`.
- `packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts` - startup policy integration tests.
- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` - replace single `promptInFlight` rejection with process-local queue orchestration.
- `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts` - queue, interrupt, and session-selection contract tests.
- `packages/ohbaby-agent/src/runtime/run-ledger/types.ts` - add claim/release semantics.
- `packages/ohbaby-agent/src/runtime/run-ledger/in-memory.ts` - in-memory claim implementation for tests.
- `packages/ohbaby-agent/src/runtime/run-ledger/in-memory.unit.test.ts` - claim behavior tests.
- `packages/ohbaby-agent/src/runtime/run-ledger/database.ts` - SQLite atomic claim implementation.
- `packages/ohbaby-agent/src/runtime/run-ledger/database.integration.test.ts` - cross-ledger claim race tests.
- `packages/ohbaby-agent/src/runtime/run-ledger/errors.ts` - add a typed busy/claim error.
- `packages/ohbaby-agent/src/runtime/run-manager/manager.ts` - use ledger claim before marking a run active.
- `packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts` - same-session active-run tests.
- `packages/ohbaby-agent/src/core/agents/runner.ts` - remove the initial user message when run creation fails before runtime execution.
- `packages/ohbaby-agent/src/core/agents/runner.unit.test.ts` - ghost-message regression test.
- `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts` - keep default persistent run IDs collision-resistant.
- `packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts` - run ID uniqueness test.
- `packages/ohbaby-cli/src/cli/commands/terminal.ts` - add `--continue`, keep `--resume`, and pass startup intent into the backend.
- `packages/ohbaby-cli/src/bin.unit.test.ts` - CLI option parsing coverage if the terminal command is covered through bin parsing.
- `packages/ohbaby-cli/src/tui/components/prompt/index.tsx` - show a queued/disabled state while the local queue has work.
- `packages/ohbaby-cli/src/tui/app.tsx` - ensure double-`Esc` abort resolves the active queue item and drains the next prompt.
- `packages/ohbaby-cli/src/tui/app.contract.test.tsx` - TUI-level queue and interrupt coverage.

Create:

- `packages/ohbaby-agent/src/adapters/ui-startup-session.ts` - pure startup policy for default, resume, and continue.
- `packages/ohbaby-agent/src/adapters/ui-startup-session.unit.test.ts` - table-driven startup policy tests.
- `packages/ohbaby-agent/src/adapters/ui-prompt-queue.ts` - process-local FIFO queue and drain controller.
- `packages/ohbaby-agent/src/adapters/ui-prompt-queue.unit.test.ts` - queue ordering, cancellation, retry, and close behavior.
- `packages/ohbaby-cli/src/cli/commands/terminal.unit.test.ts` - direct terminal-command option tests if bin coverage is too indirect.
- `tests/integration/tui/terminal-session-isolation.integration.test.tsx` - rendered TUI integration for blank startup and explicit continue.
- Phase 4 follow-up: `tests/integration/tui/prompt-queue.integration.test.tsx` - rendered multi-client/daemon TUI integration for global queued prompt drain after interrupt.

### Task 1.1: Startup Session Policy

- [x] Write failing tests in `packages/ohbaby-agent/src/adapters/ui-startup-session.unit.test.ts`.

Cover these cases:

```ts
describe("resolveStartupSession", () => {
  it("returns null for default startup even when a stored active session exists", () => {});
  it("returns the explicit resume session id for resume startup", () => {});
  it("returns the latest primary session id for continue startup", () => {});
  it("returns null for continue startup when no primary session exists", () => {});
});
```

- [x] Add `packages/ohbaby-agent/src/adapters/ui-startup-session.ts`.

Expose a small pure API:

```ts
export type StartupSessionMode =
  | { readonly type: "fresh" }
  | { readonly type: "resume"; readonly sessionId: string }
  | { readonly type: "continue" };

export type StartupSessionCandidate = {
  readonly id: string;
  readonly kind: "primary" | "temporary";
  readonly updatedAt: number;
};

export function resolveStartupSession(
  mode: StartupSessionMode,
  candidates: readonly StartupSessionCandidate[],
): string | null;
```

- [x] Run the focused test:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-startup-session.unit.test.ts
```

Expected: pass after implementation.

- [x] Wire `resolveStartupSession` into `packages/ohbaby-agent/src/adapters/ui-persistent.ts`.

Default client creation must pass `{ type: "fresh" }`. `--resume` passes `{ type: "resume", sessionId }`. `--continue` passes `{ type: "continue" }`.

- [x] Update `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts`.

`readSessions()` must no longer adopt `app_state.activeSessionId` during fresh startup. The persisted value may remain for migration compatibility, but fresh startup must report `activeSessionId: null`.

- [x] Add integration coverage in `packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts`.

Assert that a DB with a stored active session opens with `activeSessionId: null` by default, opens the explicit session with `resume`, and opens the newest primary session with `continue`.

### Task 1.2: Do Not Create Empty Sessions On Startup

- [x] Add a failing integration test in `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.integration.test.ts`.

Scenario:

1. Create a persistent backend with fresh startup.
2. Read the initial snapshot.
3. Assert `snapshot.sessions.length` is unchanged from the DB seed.
4. Assert no new empty session row was inserted.

- [x] Adjust startup and snapshot read paths so session creation only happens from an explicit create-session command or first prompt submission.
- [x] Reuse the existing empty-session reuse logic for first prompt submission, but make it reachable from one place only.
- [x] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-state/persistent-store.integration.test.ts packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts --no-file-parallelism
```

Expected: fresh startup produces no new session; first prompt creates or reuses exactly one session.

### Task 1.3: Filter Snapshot Status To The Active Session

- [x] Add failing tests in `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.unit.test.ts`.

Cases:

- Active session is `session_a`, run is active in `session_b`, status is idle.
- Active session is `session_a`, run is active in `session_a`, status is running.
- No active session, unrelated active run exists, status is idle.

- [x] Change `snapshotStatus` to accept the selected session id and only consider active runs for that session.
- [x] Update all call sites in `persistent-store.ts`.
- [x] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-state/persistent-store.unit.test.ts
```

Expected: no cross-session running status leakage.

### Task 1.4: Collision-Resistant Run IDs

- [x] Add a failing test in `packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts`.

Create two persistent backend/client instances from the same DB snapshot and assert their first generated run IDs are not equal.

- [x] Stop using process-local sequential IDs for production persistent run creation.
- [x] Keep deterministic ID injection for tests that intentionally pass a `createRunId` override.
- [x] Use the existing random/default ID path from `createUiRuntimeComposition` or a `crypto.randomUUID()`-based helper.
- [x] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
```

Expected: existing deterministic tests still pass, and production defaults are collision-resistant.

### Task 1.5: Atomic Same-Session Run Claim

- [x] Extend `packages/ohbaby-agent/src/runtime/run-ledger/types.ts`.

Add a method with this meaning:

```ts
claimPendingRun(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly createdAt: number;
}): Promise<void>;
```

The method must atomically create a pending run only when the session has no `pending` or `running` run.

- [x] Add `SessionRunBusyError` in `packages/ohbaby-agent/src/runtime/run-ledger/errors.ts`.
- [x] Write failing tests in `packages/ohbaby-agent/src/runtime/run-ledger/in-memory.unit.test.ts`.

Cases:

- First claim for a session succeeds.
- Second claim for the same session fails while first is pending.
- Second claim succeeds after the first run is marked `succeeded`, `failed`, `cancelled`, or `interrupted`.
- Claims for different sessions both succeed.

- [x] Implement the same semantics in `packages/ohbaby-agent/src/runtime/run-ledger/in-memory.ts`.
- [x] Write SQLite race coverage in `packages/ohbaby-agent/src/runtime/run-ledger/database.integration.test.ts`.

Open two ledger instances over the same database and race two `claimPendingRun` calls for the same session with `Promise.allSettled`. Assert exactly one succeeds and one rejects with `SessionRunBusyError`.

- [x] Implement SQLite claim in `packages/ohbaby-agent/src/runtime/run-ledger/database.ts`.

Use a transaction and an active-run existence check against `pending` and `running` statuses. The insert and check must be in the same transaction.

- [x] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/run-ledger/in-memory.unit.test.ts packages/ohbaby-agent/src/runtime/run-ledger/database.integration.test.ts --no-file-parallelism
```

Expected: same-session claim is single-winner across two DB clients.

### Task 1.6: Run Manager Uses Ledger Claim

- [x] Add failing tests in `packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts`.

Cases:

- `RunManager.create()` maps `SessionRunBusyError` to the existing active-run policy error surface or a new typed busy error.
- A second run for the same session cannot become active in memory if the ledger rejects the claim.
- A second run for another session can start.

- [x] Update `packages/ohbaby-agent/src/runtime/run-manager/manager.ts` so run creation goes through `claimPendingRun`.
- [x] Ensure `markRunning`, `markSucceeded`, `markFailed`, `markCancelled`, and `markInterrupted` still release the claim through ledger status transition.
- [x] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts packages/ohbaby-agent/src/runtime/run-manager/policy.unit.test.ts
```

Expected: run-manager policy remains compatible while persistence prevents cross-process concurrency.

### Task 1.7: Ghost User Message Regression

- [x] Add a failing test in `packages/ohbaby-agent/src/core/agents/runner.unit.test.ts`.

Scenario:

1. Stub the run coordinator so `create()` rejects with `SessionRunBusyError`.
2. Submit a prompt.
3. Assert the initial user message is removed or never committed.
4. Assert no assistant/runtime messages are written.
5. Assert the caller receives a busy result that the prompt queue can retry.

- [x] Update `packages/ohbaby-agent/src/core/agents/runner.ts`.

If run creation fails before runtime execution begins, clean up the initial user message through the message manager/store path already used by the runner. If the existing message API lacks delete support, add the smallest scoped delete-by-id method to the message store and cover it in existing message-store tests.

- [x] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/core/agents/runner.unit.test.ts packages/ohbaby-agent/src/core/message/manager.unit.test.ts packages/ohbaby-agent/src/core/message/database-store.integration.test.ts --no-file-parallelism
```

Expected: busy claim failure leaves no ghost user message.

### Task 1.8: Process-Local Prompt FIFO

- [x] Add `packages/ohbaby-agent/src/adapters/ui-prompt-queue.unit.test.ts`.

Cover:

- Enqueued prompts drain in insertion order.
- A second prompt waits while the first promise is unresolved.
- A rejected busy attempt remains at the head and retries after a delay or busy-state notification.
- Cancelling the active run resolves the active item and starts the next item.
- Closing the queue rejects unsent items with a typed local shutdown error.

- [x] Add `packages/ohbaby-agent/src/adapters/ui-prompt-queue.ts`.

Expose a focused controller:

```ts
export type PromptQueueItem = {
  readonly text: string;
  readonly sessionId: string | null;
};

export type PromptQueueSubmit = (item: PromptQueueItem) => Promise<void>;

export type PromptQueueOptions = {
  readonly submit: PromptQueueSubmit;
  readonly isBusyError: (error: unknown) => boolean;
  readonly retryDelayMs: number;
};

export class PromptQueueController {
  constructor(options: PromptQueueOptions);
  enqueue(item: PromptQueueItem): Promise<void>;
  size(): number;
  close(): void;
}
```

- [x] Use the controller from `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`.

`submitPrompt` should enqueue. The internal prompt execution path should still call the existing runtime composition, but it should run only from the queue drain loop.

- [x] Add contract coverage in `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`.

Assert two fast `submitPrompt()` calls execute in order. Assert the second starts after a simulated `run.interrupted` from the first.

- [x] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-prompt-queue.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
```

Expected: same-process FIFO is deterministic.

### Task 1.9: TUI Queue And Double-Esc UX

- [x] Add rendered tests in `packages/ohbaby-cli/src/tui/app.contract.test.tsx` or `tests/integration/tui/prompt-queue.integration.test.tsx`.

Cases:

- Submitting prompt A then prompt B while A is running keeps prompt B queued.
- Double-`Esc` aborts A.
- B starts automatically after the abort event resolves A.
- The prompt input shows a queued/running state without accepting duplicate submit of the same editor content.

- [x] Update `packages/ohbaby-cli/src/tui/components/prompt/index.tsx`.

Display concise state text such as `Queued` for Phase 1 local queued submissions while runtime is active. Keep keyboard interaction stable; richer backend-exposed queue state is deferred to Phase 4 daemon mode.

- [x] Update `packages/ohbaby-cli/src/tui/app.tsx`.

Double-`Esc` should continue calling `client.abortRun(runtime.runId)`. The queue drain must react to the abort completion instead of requiring separate TUI-specific logic.

- [x] Run:

```powershell
pnpm exec vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx --no-file-parallelism
```

Expected: backend queue drain after interrupt is covered by `ui-inprocess.contract.test.ts`; rendered TUI coverage shows the local `Queued` state while a running session accepts a follow-up.

### Task 1.10: CLI `--continue`

- [x] Add tests in `packages/ohbaby-cli/src/cli/commands/terminal.unit.test.ts` or extend `packages/ohbaby-cli/src/bin.unit.test.ts`.

Cases:

- `ohbaby terminal` maps to fresh startup.
- `ohbaby terminal --resume session_123` maps to resume startup.
- `ohbaby terminal --continue` maps to continue startup.
- `--resume` and `--continue` together fail with a clear CLI error.

- [x] Update `packages/ohbaby-cli/src/cli/commands/terminal.ts`.
- [x] Run:

```powershell
pnpm exec vitest run packages/ohbaby-cli/src/cli/commands/terminal.unit.test.ts packages/ohbaby-cli/src/bin.unit.test.ts
```

Expected: CLI startup intent is explicit.

### Phase 1 Verification And Commit

- [x] Run all verification commands listed at the top of this plan.

Note: `pnpm test:integration` passed all non-packaging integration files on the full run. `tests/integration/cli/packaging-smoke.integration.test.ts` timed out once during the full concurrent run, then passed when rerun directly in 167s, close to its 180s internal timeout.
- [x] Cover the two-terminal check:

```powershell
pnpm run build
pnpm start
pnpm start
```

Expected:

- Both terminals open with no selected session by default.
- Prompting in terminal A creates a session.
- Terminal B remains blank until prompted or explicitly continued.
- Two prompts submitted quickly in terminal A run FIFO.
- Double-`Esc` during prompt A starts prompt B automatically.

Evidence: `tests/integration/tui/persistent-display.integration.test.tsx` covers two fresh persistent TUI clients sharing one DB while the second terminal remains blank after the first creates a session. `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts` covers local FIFO and double-`Esc`/abort drain. `packages/ohbaby-cli/src/tui/app.contract.test.tsx` covers rendered `Queued` feedback. A live visual two-window run was not performed in this non-interactive session.

- [x] Request subagent code review for Phase 1.
- [x] All Phase 1 work lives as per-task scoped commits on `feat/terminal-daemon-phase-1` (e.g. `fix(agent): claim session runs atomically`, `feat(cli): add --continue startup`). Merge is intentionally deferred until the user requests it:

```powershell
git switch mvp
git merge --no-ff feat/terminal-daemon-phase-1
```

---

## Phase 2: Split In-Process UI Backend

**Outcome:** Behavior remains the same as Phase 1, but the 1600+ line `ui-inprocess.ts` is split into focused units so daemon work does not pile onto one large file.

### File Structure

Modify:

- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` - shrink to assembly/composition.
- `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts` - keep public behavior contract unchanged.

Create:

- `packages/ohbaby-agent/src/adapters/ui-inprocess/session-controller.ts` - active session, create, rename, delete, and empty-session reuse.
- `packages/ohbaby-agent/src/adapters/ui-inprocess/prompt-controller.ts` - prompt queue binding to runtime execution.
- `packages/ohbaby-agent/src/adapters/ui-inprocess/runtime-controller.ts` - runtime creation, stream binding, abort handling.
- `packages/ohbaby-agent/src/adapters/ui-inprocess/event-router.ts` - app-event subscription and snapshot invalidation.
- `packages/ohbaby-agent/src/adapters/ui-inprocess/types.ts` - local shared types only.
- Unit tests next to each new file.

### Task 2.1: Characterization Tests

- [x] Add or expand contract tests before moving code.

Cover:

- create session from command.
- first prompt session creation/reuse.
- rename/delete active session.
- submit prompt success.
- abort active run.
- queued prompt behavior from Phase 1.

- [x] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
```

Expected: all behavior is characterized before refactor.

### Task 2.2: Extract Session Controller

- [x] Move session-specific logic into `session-controller.ts`.
- [x] Keep public `UiBackendClient` method names unchanged.
- [x] Add unit tests for active-session transitions and empty-session reuse.
- [x] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess/session-controller.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
```

Expected: no behavior change.

### Task 2.3: Extract Prompt And Runtime Controllers

- [x] Move queue binding into `prompt-controller.ts`.
- [x] Move runtime construction, run stream subscription, and abort handling into `runtime-controller.ts`.
- [x] Ensure the prompt controller depends on an interface, not on concrete TUI code.
- [x] Add unit tests for queue-to-runtime transitions.
- [x] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess/prompt-controller.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess/runtime-controller.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
```

Expected: prompt behavior is unchanged.

### Task 2.4: Extract Event Router

- [x] Move app-event subscription logic into `event-router.ts`.
- [x] Add unit tests for event-to-snapshot invalidation.
- [x] Keep `ui-inprocess.ts` as a small composition module.
- [x] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess/event-router.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
```

Expected: event delivery and snapshots remain stable.

### Phase 2 Verification And Commit

- [x] Run all verification commands listed at the top of this plan.
- [x] Request subagent code review for Phase 2, focused on accidental behavior drift.
- [x] Per-task scoped commits on `feat/terminal-daemon-phase-2` (e.g. `refactor(agent): extract session controller`). After review passes, merge:

```powershell
git switch mvp
git merge --no-ff feat/terminal-daemon-phase-2
```

---

## Phase 3: Explicit Daemon And Remote UI Client

**Outcome:** `serve` starts a real backend coordinator. A terminal can connect as a remote client. The in-process client remains available for rollback and tests.

### File Structure

Modify:

- `packages/ohbaby-cli/src/cli/commands/serve.ts` - replace stub with daemon server startup.
- `packages/ohbaby-cli/src/cli/commands/terminal.ts` - add connection option and remote-client path.
- `packages/ohbaby-agent/src/runtime/daemon/bootstrap.ts` - wire persistent backend into daemon lifecycle.
- `packages/ohbaby-agent/src/runtime/daemon/supervisor.ts` - prepare explicit server process management.
- `packages/ohbaby-agent/src/index.ts` - export daemon/client factories if needed.

Create:

- `packages/ohbaby-agent/src/runtime/daemon/protocol.ts` - request/response and event envelope types.
- `packages/ohbaby-agent/src/runtime/daemon/server.ts` - localhost HTTP + WebSocket server (Hono, per 02-solution-design; chosen over named pipes for Windows reliability and direct Web/App reuse).
- `packages/ohbaby-agent/src/runtime/daemon/client.ts` - remote `UiBackendClient` implementation.
- `packages/ohbaby-agent/src/runtime/daemon/permission-router.ts` - route permission requests to the initiating client; queue pending requests on disconnect.
- `packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts` - daemon server/client contract.
- `tests/integration/cli/daemon-terminal.integration.test.ts` - terminal connects to explicit daemon.

### Task 3.1: Protocol Contract

- [ ] Define protocol envelopes in `protocol.ts`.

Include:

- `snapshot.get`
- `prompt.submit`
- `run.abort`
- `session.create`
- `session.resume`
- `session.continue`
- `events.subscribe`
- `permission.request` (server -> client push)
- `permission.respond` (client -> server)

- [ ] Add protocol tests that serialize and deserialize every envelope.
- [ ] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/protocol.unit.test.ts
```

Expected: protocol is stable and typed.

### Task 3.2: Daemon Server

- [ ] Implement `server.ts` around the existing persistent backend.
- [ ] Keep one backend instance inside the daemon process.
- [ ] Stream events to connected clients using the selected local transport.
- [ ] Add integration tests that connect two clients and assert both see session/run events.
- [ ] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts --no-file-parallelism
```

Expected: one daemon coordinates multiple clients.

### Task 3.3: CLI `serve`

- [ ] Replace the `serve` stub in `packages/ohbaby-cli/src/cli/commands/serve.ts`.
- [ ] Add CLI tests for startup, port/path selection, and invalid options.
- [ ] Run:

```powershell
pnpm exec vitest run packages/ohbaby-cli/src/cli/commands/serve.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/bootstrap.integration.test.ts
```

Expected: `ohbaby serve` starts the daemon and reports connection details.

### Task 3.4: Remote Terminal Client

- [ ] Implement `client.ts` as a `UiBackendClient`.
- [ ] Add terminal option to connect to an explicit daemon.
- [ ] Add integration test with one daemon and two terminal clients.
- [ ] Run:

```powershell
pnpm exec vitest run tests/integration/cli/daemon-terminal.integration.test.ts --no-file-parallelism
```

Expected: remote terminal behavior matches Phase 1 local behavior.

### Task 3.5: Permission Proxying And Routing

Without this, the first tool call needing authorization deadlocks every remote client (04-test-criteria 3.3 requires permission prompts to work in remote mode).

- [ ] Implement `permission-router.ts`: route each permission request to the client that initiated the run; other connected clients receive a read-only notification.
- [ ] Queue pending permission requests when the initiating client disconnects; deliver to the next client that attaches to that session (kimi-code `ReverseRpcController` pattern).
- [ ] Integration test: a remote client receives the permission request during a tool call and can approve/deny; a second observing client never gets the interactive prompt; disconnect-then-reattach delivers the queued request.
- [ ] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts --no-file-parallelism
```

Expected: permissions work end-to-end in remote mode with multiple clients.

### Phase 3 Verification And Commit

- [ ] Run all verification commands listed at the top of this plan.
- [ ] Request subagent code review for Phase 3, focused on protocol correctness, permission routing, lifecycle cleanup, and event fanout.
- [ ] Per-task scoped commits on `feat/terminal-daemon-phase-3` (e.g. `feat(daemon): add ui protocol server`). After review passes, merge:

```powershell
git switch mvp
git merge --no-ff feat/terminal-daemon-phase-3
```

---

## Phase 4: Auto-Spawn Daemon And Global FIFO

**Outcome:** `pnpm start` uses the daemon by default. Prompt ordering for the same session is strict FIFO across terminals and future Web/App clients.

### File Structure

Modify:

- `packages/ohbaby-agent/src/runtime/daemon/supervisor.ts` - discover, validate, and spawn daemon.
- `packages/ohbaby-agent/src/runtime/daemon/state-file.ts` - connection metadata and stale-daemon recovery.
- `packages/ohbaby-agent/src/runtime/daemon/pid-file.ts` - process liveness validation.
- `packages/ohbaby-agent/src/runtime/daemon/server.ts` - global queue ownership.
- `packages/ohbaby-agent/src/runtime/daemon/client.ts` - queue state projection.
- `packages/ohbaby-agent/src/adapters/ui-persistent.ts` - evaluate whether the Phase 1 backend lease remains only for in-process fallback.
- `packages/ohbaby-cli/src/cli/commands/terminal.ts` - default to supervisor-backed daemon.

Create:

- `packages/ohbaby-agent/src/runtime/daemon/prompt-queue.ts` - persistent/global FIFO queue inside daemon.
- `packages/ohbaby-agent/src/runtime/daemon/prompt-queue.unit.test.ts` - ordering and cancellation tests.
- `tests/integration/cli/daemon-global-fifo.integration.test.ts` - two terminal clients, one session, strict FIFO.

### Task 4.1: Supervisor Auto-Spawn

- [ ] Add tests in `packages/ohbaby-agent/src/runtime/daemon/supervisor.unit.test.ts`.

Cases:

- Reuse healthy daemon.
- Ignore stale pid file.
- Spawn daemon when none exists.
- Fail clearly when daemon cannot bind.

- [ ] Implement supervisor changes.
- [ ] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/supervisor.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/pid-file.unit.test.ts
```

Expected: daemon discovery is deterministic.

### Task 4.2: Global FIFO Queue

- [ ] Add `packages/ohbaby-agent/src/runtime/daemon/prompt-queue.unit.test.ts`.

Cover:

- Prompts from client A then client B for one session run A then B.
- Prompts for different sessions may run independently if existing run policy allows it.
- Interrupting active prompt A starts queued prompt B.
- Disconnecting a client does not cancel an already accepted prompt unless the client explicitly aborts it.
- Daemon shutdown marks accepted but unstarted prompts with a clear terminal state.

- [ ] Implement `packages/ohbaby-agent/src/runtime/daemon/prompt-queue.ts`.
- [ ] Wire daemon server prompt handling through the global queue.
- [ ] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/prompt-queue.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts --no-file-parallelism
```

Expected: daemon owns cross-client ordering.

### Task 4.3: Default Terminal Uses Daemon

- [ ] Update terminal startup to use the supervisor by default.
- [ ] Keep an escape hatch for in-process mode if needed for debugging, named clearly such as `--in-process`.
- [ ] Add CLI tests for default daemon, explicit daemon, and in-process modes.
- [ ] Run:

```powershell
pnpm exec vitest run packages/ohbaby-cli/src/cli/commands/terminal.unit.test.ts tests/integration/cli/daemon-terminal.integration.test.ts --no-file-parallelism
```

Expected: default startup is daemon-backed.

### Task 4.4: Cross-Terminal Strict FIFO E2E

- [ ] Add `tests/integration/cli/daemon-global-fifo.integration.test.ts`.

Scenario:

1. Start one daemon.
2. Connect terminal client A and terminal client B to the same resumed session.
3. Submit prompt A, then prompt B.
4. Assert daemon emits run A before run B.
5. Interrupt run A.
6. Assert run B starts automatically.
7. Assert both clients render the same final session history.

- [ ] Run:

```powershell
pnpm exec vitest run tests/integration/cli/daemon-global-fifo.integration.test.ts --no-file-parallelism
```

Expected: strict FIFO holds across terminal processes.

### Task 4.5: Daemon Lifecycle Hardening (Version Handshake And Idle Exit)

Both mechanisms are required for the published-npm form (02-solution-design 3.4 marks them non-optional); without them a stale daemon survives npm upgrades and an idle daemon lingers forever.

- [ ] State file records the daemon's package version alongside connection metadata.
- [ ] Client compares versions on connect; on mismatch it asks the old daemon to shut down gracefully, waits for state-file cleanup, then spawns the current version.
- [ ] Daemon exits automatically after the last client disconnects and an idle timeout elapses (default 15 minutes); pid/state files are cleaned up on exit.
- [ ] Tests: version-mismatch handover, idle self-exit with fake timers (no real `setTimeout` waits), no orphan pid/state files after either path.
- [ ] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/supervisor.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/state-file.unit.test.ts
```

Expected: npm upgrades replace the daemon transparently; no daemon lingers when unused.

### Task 4.6: Backend Lease Retention Decision

Phase 1 introduced `persistentUiBackendLease` as a global write mutex for embedded persistent backends. Once Phase 4 makes the daemon the default single writer, this lease must be either scoped to the in-process fallback or retired from the daemon path.

- [ ] Add tests proving the default daemon-backed terminal path does not rely on `persistentUiBackendLease` to order prompts.
- [ ] Ensure daemon global FIFO and per-session RunState are the only prompt-ordering gates in daemon mode.
- [ ] Keep cross-process protection for the explicit in-process escape hatch (`--in-process` / `--no-daemon`) if that path remains supported.
- [ ] Verify a stale or `preparing` backend lease cannot block daemon startup, daemon prompt submission, or daemon queue drain.
- [ ] Document the final decision in `02-solution-design.md` 3.5 before Phase 4 merge.
- [ ] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts --no-file-parallelism
```

Expected: daemon mode is coordinated by the daemon, while any retained in-process fallback still has explicit cross-process protection and tests.

### Phase 4 Verification And Commit

- [ ] Run all verification commands listed at the top of this plan.
- [ ] Run manual two-terminal daemon check:

```powershell
pnpm run build
pnpm start
pnpm start -- --continue
```

Note: root `start` nests `pnpm --filter ohbaby-cli start`; verify the flag survives both pnpm layers (a second `--` may be required, e.g. `pnpm start -- -- --continue`).

Expected:

- The first terminal starts or connects to the daemon.
- The second terminal connects to the same daemon.
- Same-session prompts are globally FIFO.
- Double-`Esc` in the terminal showing the active run starts the next queued prompt.

- [ ] Request subagent code review for Phase 4, focused on daemon lifecycle (version handshake, idle exit), strict FIFO, stale state, and cross-client rendering.
- [ ] Per-task scoped commits on `feat/terminal-daemon-phase-4` (e.g. `feat(daemon): auto-spawn with version handshake`). After review passes, merge:

```powershell
git switch mvp
git merge --no-ff feat/terminal-daemon-phase-4
```

---

## ACP And A2A Decision

Do not add ACP or A2A infrastructure in this plan's core path.

The correct near-term abstraction is a stable internal `UiBackendClient` plus a daemon protocol that can support terminal, Web, and App clients. ACP can be added later as an adapter if external IDE/editor integration requires it. A2A should wait until the product actually has multiple autonomous agents that need a protocol for delegation, discovery, or negotiation. Adding either now would increase surface area before the runtime has a single reliable coordinator.

## Acceptance Criteria

- Fresh terminal startup no longer resumes the most recent session implicitly.
- Fresh terminal startup no longer creates an empty session.
- Explicit resume and continue behavior is deterministic.
- Same terminal prompt submissions use FIFO queueing.
- Double-`Esc` interruption drains the next local queued prompt in Phase 1 and the next daemon queued prompt in Phase 4.
- Same-session concurrent runs are prevented across processes in Phase 1.
- Cross-terminal strict FIFO is provided by the daemon in Phase 4.
- No ghost user message remains when run creation fails because a session is busy.
- Production run IDs do not collide across terminal processes started from the same DB snapshot.
- Status rendering does not leak active runs from unrelated sessions.
- Permission prompts work in remote mode: requests route to the initiating client, queue across disconnects, and never deadlock (Phase 3).
- Backend lease semantics are explicit after Phase 4: daemon mode does not depend on the Phase 1 lease, and any retained in-process fallback remains protected.
- npm upgrades replace a running daemon via version handshake; an idle daemon exits on its own (Phase 4).
- Unit, contract, integration, e2e snapshot, real `.env` smoke, lint, typecheck, and build pass after every phase.
- A review subagent checks every phase before merge.

## Self-Review

Spec coverage:

- P1 active session global leakage is covered by Phase 1 startup policy.
- P2/P7 process-local `promptInFlight` and cross-process concurrency are covered by Phase 1 local queue and database claim.
- P3 implicit startup behavior is covered by fresh/resume/continue modes.
- P4/P5 empty-session reuse and large `ui-inprocess.ts` are covered by Phase 1 first-prompt creation and Phase 2 extraction.
- P6/P8 daemon production path is covered by Phases 3 and 4.
- P9 `snapshotStatus` leakage is covered by Phase 1 status filtering.
- P10 ghost user message (01-problem-analysis) is covered by Task 1.7.
- P11 run ID collision (01-problem-analysis) is covered by Task 1.4.
- Double-`Esc` queued follow-up behavior is covered in Phase 1 and Phase 4.
- Web/App readiness is covered through the daemon protocol; ACP/A2A are intentionally deferred.

Placeholder scan:

- The plan contains concrete files, tests, commands, commit points, and acceptance criteria.
- No unresolved placeholder sections remain.

Type and naming consistency:

- Startup names use `fresh`, `resume`, and `continue` consistently.
- Queue names use `PromptQueueController`, `PromptQueueItem`, and `PromptQueueSubmit` consistently.
- Ledger claim naming uses `claimPendingRun` consistently.
- Phase 1 local FIFO and Phase 4 global FIFO are separated consistently.

Residual risks for review:

- The message cleanup in Phase 1 depends on the current message-store delete capabilities. If no delete-by-id API exists, add the narrowest message deletion method and test both memory and database stores in the same phase.
- The SQLite atomic claim must be verified under two real database clients. An in-memory fake is not sufficient evidence for the race.
- The daemon transport in Phase 3 should be selected for Windows reliability first, since the current workspace is Windows PowerShell.
