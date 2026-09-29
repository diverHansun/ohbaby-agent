# REST/RPC invalid choices and terminal eviction

Added three tests to `packages/ohbaby-server/src/coordination/permission-lifecycle.integration.test.ts` using real `createInProcessUiBackendClient`, its scheduler, manager, projection, and the actual REST/RPC routes. A deterministic provider requests bash tools; no approval state or response method is mocked. Every test uses a temporary workspace, and teardown disposes both app and backend and removes the workspace.

- Normal and sensitive `.env` requests exercise unknown choice, Cancel run, contradictory `remember`, and nonrememberable `allow_always` through both REST and RPC. Each invalid answer returns `INVALID_PERMISSION_CHOICE`, leaves the same request pending, and creates no rule. A valid reject ends the tool wait. An already-resolved ID still rejects a different root, and a duplicate answer from the correct root succeeds idempotently without executing the rejected command.
- Default terminal-cache eviction is exercised with 1,025 rejected real tool approvals, followed by a separate live request. Both protocols return `PERMISSION_NOT_PENDING` for the evicted ID from both a formerly correct root and another registered root, without exposing the old call identity. The live request remains pending, no rule is written, and the shell output file remains absent. No production test-only capacity setting was added.

The first test run found an incorrect expected error-code spelling in the new test (`PERMISSION_INVALID_CHOICE` instead of the existing `INVALID_PERMISSION_CHOICE`); this was corrected against the existing public error type. The eviction regression passed on its first run. No missing production implementation was found and no product code was changed, so these are additional acceptance coverage, not a claimed RED/GREEN product fix.

Verification:

- `pnpm exec vitest run packages/ohbaby-server/src/coordination/permission-lifecycle.integration.test.ts --reporter=dot`: 10 passed. `/tmp/permission-validation-transport-green.log`.
- Targeted ESLint: no errors or warnings.
- `pnpm exec tsc --noEmit -p packages/ohbaby-server/tsconfig.json --pretty false`: passed. `/tmp/permission-validation-transport-typecheck.log`.

No runtime rebuild, commit, or push was performed for these tests.

## Final exact-combination additions

Eight additional cases close the bounded follow-up audit:

- T05: six cases start concurrent REST and RPC answers and pause both at metadata validation barriers. Either protocol is released first; allow/allow, allow/reject and reject/allow orderings each produce exactly one resolved event. The first decision determines the real tool result: one `x` append after Allow once, or no file after Reject. Duplicate responses remain idempotent and no session rule is created.
- T12e: client A's real HTTP approval query fails and its shared recovery engine reaches error with a one-attempt test budget. The backend request remains pending. Client B independently obtains a ready baseline and answers through RPC; A remains unready until explicit retry, which reads revision2 and an empty request list. The command appends exactly once. Both clients consume the backend's independent permission event contract.
- T17: a real localhost `createDaemonHttpServer` routes two temporary workspaces to two actual inprocess backends, with the same root/client names and one pending request in each. Sending workspace A's request ID through workspace B's REST/RPC route is rejected both with A's stale epoch and B's valid local binding. Both pending sets, rule sets and unexecuted shell files remain unchanged. Workspace paths are compared canonically; the first test run exposed only a macOS `/var` versus `/private/var` assertion mistake, not a production defect.

Final focused result: **18 tests passed** in `permission-lifecycle.integration.test.ts`, about1.9seconds test time. `/tmp/permission-final-combinations-green.log`. Targeted ESLint is clean, and server `tsc --noEmit` passed (`/tmp/permission-final-combinations-typecheck.log`). No product changes or rebuild were needed. The 05 report remains owned by the root task for final status updates.

## Full-suite HTTP ordering fixture repair

The final full suite found one failing legacy daemon test: two concurrent unregistered clients could complete their registration handshakes in reverse order, so backend.submitted was [second, first]. The assertion assumed HTTP arrival ordering, which is not the accepted-prompt FIFO contract. The same expectation exists at baseline81cd4b00. Changed only the test: wait until the first request is admitted (its response remains held), then launch the second, still requiring both to reach backend before releasing either. This retains the no-second-queue-owner assertion and removes network timing as an ordering oracle. Server integration45tests passed after the barrier. No production change. Log /tmp/ohbaby-improve1-admission-barrier.log.
