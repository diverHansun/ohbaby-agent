# Pi P1: repeated ready binding confirmations

The independent Pi review identified that an unchanged hello or prompt receipt called `begin` again on the same connection and binding. The old unchanged branch invoked `resync` even when already ready. Normal confirmations therefore consumed the four-query recovery budget; after exhaustion the client stopped applying new permission events.

## Reproduction and correction

Two new tests failed before the production change:

- SDK: after a ready revision1 baseline, the first unchanged confirmation changed the state to syncing and attempts2 instead of remaining ready with one query.
- Actual Web runtime: six unchanged hello frames plus six accepted prompt HTTP receipts ended in error with attempts4. A later approval would not be actionable.

RED output: `/tmp/permission-pi-unchanged-red.log`.

The minimal fix makes `begin` a no-op only when binding, connection generation and ready status are all unchanged. It does not reset attempts when installing a baseline. Active recovery retains the cumulative query budget; explicit resync/gaps still consume attempts, and a real new connection still obtains a fresh baseline. Existing cumulative retry/gap/hello tests remain unchanged.

The new Web regression submits six prompts through the actual BrowserDaemonClient HTTP path while injecting six unchanged SSE hello frames. It then delivers a new revision2 request, verifies that it appears, and successfully answers that request with its binding context. The SDK regression repeats eight confirmations, applies a later request, then verifies that a genuinely new connection queries again. A test fixture timestamp was adjusted to represent a later-created request rather than asserting the wrong ordering for equal timestamps.

## Verification

- `pnpm exec vitest run packages/ohbaby-sdk/src/permission-sync.unit.test.ts apps/ohbaby-web/src --reporter=dot`: **278 tests / 19 files passed**, `/tmp/permission-pi-unchanged-green.log`.
- Targeted ESLint on the SDK implementation/test and Web recovery integration test: clean.
- SDK and Web `tsc --noEmit` checks passed: `/tmp/permission-pi-sdk-typecheck.log`, `/tmp/permission-pi-web-typecheck.log`.

No build or commit was performed. Server notification suppression and the separate Remote command-contract review finding are handled by the server owner; the client correction does not depend on suppressing redundant server confirmations.
