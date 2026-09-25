# Bulk revocation reentrancy correction

## Reproduced failure

During `revokeByRun`, the first resolved notification could synchronously answer the second pending request with `always`. The first wait cancelled, but the second returned `always` and wrote a session rule. The same interleaving affected source/ancestor/root cleanup, `cancelPending`, and `clearSession`.

A second path let a valid `always` answer from another run in the same source session automatically approve a request already targeted by the active cleanup batch.

## Red and green

- RED: seven added regressions failed before implementation. Six cleanup entry points accepted the reentrant answer instead of returning `revoked`; the automatic-approval case returned `[cancel, always, always]` instead of `[cancel, cancel, always]`. Command output: `/tmp/permission-bulk-revoke-red.log`.
- GREEN: a scoped guard now covers the whole synchronous cleanup batch, including commit and notification callbacks. Matching asks cancel before policy/rule fast paths; matching direct and automatic answers cannot acquire ownership. Unrelated requests remain operable. The guard is released in `finally`, preserving nested cleanup and root failure handling.
- Additional controls cover nested cleanup, guard release, disposal, and a failed critical commit that freezes one root while cleanup continues in another healthy root.

## Verification

`pnpm exec vitest run packages/ohbaby-agent/src/permission packages/ohbaby-agent/src/adapters/app-events/permission-projection.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/permission-source.unit.test.ts tests/integration/core/tool-scheduler-permission.integration.test.ts tests/integration/agents/permission-run-lifecycle.integration.test.ts --reporter=dot`

158 tests passed in 10 files. Output: `/tmp/permission-bulk-revoke-green.log`.

`pnpm exec eslint packages/ohbaby-agent/src/permission/manager.ts packages/ohbaby-agent/src/permission/permission-lifecycle.unit.test.ts`: clean.

`pnpm exec tsc --noEmit -p packages/ohbaby-agent/tsconfig.json --pretty false`: passed without rebuilding runtime assets. Output: `/tmp/permission-bulk-revoke-typecheck.log`.
