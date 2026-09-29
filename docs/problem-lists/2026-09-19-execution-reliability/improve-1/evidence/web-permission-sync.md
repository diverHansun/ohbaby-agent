> Implementation working notes. Final acceptance is recorded in ../05-implementation-acceptance.md.

# improve-1 S3/S4 Web and shared permission recovery evidence

## Implementation scope

- New SDK `permission-sync.ts` provides independent bounded approval recovery. Binding and connection fences prevent stale A→B→A results; registered requests use per-root revisions independently of global event sequence numbers.
- Four cumulative queries per connection/scope or explicit recovery cycle, 10-second query timeout, 100/250/500 ms retry delays, and 1024-event/2-MiB candidate limits. Tests inject smaller resource limits where useful.
- End-of-stream immediately removes readiness; actual hello reconnect restarts recovery. Repeated same-connection hello/resync coalesces without resetting the query budget. Unavailable roots cannot retry/reconnect open within the same runtime epoch.
- Web registration+hello completes independently from history/model loading. Permission events bypass chat event buffering/cursors. Lightweight session index and full chat snapshot are distinct reads; full snapshot permission copies never override independent pending/readiness.
- Replies use the captured epoch/root/binding context. PERMISSION_NOT_PENDING triggers recovery and resolves the public void response. Late old-scope errors cannot alter the current scope.
- Approval card mounts without a chat snapshot and uses its own readiness. It displays actual source, supports previous/next independent requests, and omits Cancel run.

## TDD observations

1. SDK initial 13 tests failed against the unimplemented factory, then passed after the recovery implementation.
2. Initial Web regressions all timed out because `runtime.ready` awaited the intentionally unresolved history query. After decoupling, the three tests passed: history/model isolation, independent event cursor/late snapshot isolation, and selection without history.
3. UI independent card test failed because no `setPermissionSync` existed. After store/card wiring it passed, including selecting and answering the second request with composer still unavailable.
4. Review tests found three SDK failures: unavailable retry/reconnect reopened queries; duplicate baseline IDs were accepted; and lower-revision snapshots could roll back state. All were fixed and the SDK suite now has 17 passing tests.
5. Additional Web regressions cover processing SSE while approval HTTP is unresolved, end-of-stream readiness loss and automatic reconnect, and not-pending response recovery. They use the actual Web runtime/HTTP/SSE reader with controlled transport fixtures.

## Final local checks

- `pnpm exec vitest run apps/ohbaby-web/src packages/ohbaby-sdk/src/permission-sync.unit.test.ts --reporter=dot`: 19 files, 272 tests pass.
- `pnpm exec eslint packages/ohbaby-sdk/src/permission-sync.ts packages/ohbaby-sdk/src/permission-sync.unit.test.ts apps/ohbaby-web/src`: no errors or warnings.
- Full `pnpm exec tsc -b --pretty false` had no errors in this scope; remaining concurrent integration-fixture category errors were reported to the root agent for correction.
- Existing tests were migrated where the contract intentionally changed: history/model errors do not reject selection or tear down healthy SSE; `runtime.ready` is no longer a full-history/model barrier; dedicated create/select APIs replace command-generated session mutation.

## Shared API

`createPermissionSync({ query(binding, signal), onChange?, limits? })` returns `getState`, `begin(binding, connectionGeneration)`, `receive(event)`, `disconnect`, `resync`, `retry`, `dispose`.

`PermissionSyncState` includes `status`, `binding`, `requests`, `permissionRevision`, `attempts`, and optional `error`. Call `begin` only after subscription confirmation or validated selection on an already-confirmed connection. Supply a fresh connection generation only for a real connection, not repeated hello/control messages. `receive` is synchronous and must run before global sequence filtering.

Actual compiled browser/TUI/model checks and final full-repository gate are coordinated by the root task; the deterministic checks above do not claim those are complete.

## Independent review corrections

Added three regressions and observed RED before fixes: an old-generation global unavailable event froze a newer binding; a throwing permission observer prevented healthy subscriber delivery; a delayed selection receipt could restore ready during SSE error backoff. Fixes apply the generation fence to global unavailable, remove and isolate failed observers, and immediately mark transport non-live on reader failure.

GREEN: `pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-runtime/permission-source.unit.test.ts packages/ohbaby-sdk/src/permission-sync.unit.test.ts apps/ohbaby-web/src --reporter=dot` passed 296 tests in 20 files. Targeted ESLint passed. Evidence: `/tmp/permission-review-red.log`, `/tmp/permission-transport-red.log`, `/tmp/permission-review-green.log`.
