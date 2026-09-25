> Implementation working notes. Final acceptance is recorded in ../05-implementation-acceptance.md.

# improve-1 S2 permission source wrapper evidence

Scope: `packages/ohbaby-agent/src/adapters/ui-runtime/permission-source.ts` and its unit tests. Factory resolves application source identity before manager registration; it does not own the shared manager lifecycle.

## TDD evidence

- RED 1: 16 new cases executed against the exported unimplemented factory; all 16 failed with `Permission source port is not implemented`.
- GREEN 1: all 16 passed using the real permission manager.
- RED 2: added changed-parent lookup, pre-aborted lookup, and cycle validation cases. The cycle case failed because an existing pending request remained after a later traversal discovered a cycle (18 passed, 1 failed).
- GREEN 2: invalidating the repeated node before rejecting the cycle made all 19 pass.
- RED 3: shared-child source label case failed (`First agent` received, `Second agent` expected) because the wrapper omitted context scope.
- GREEN 3: pass the original contextScopeId to the source record lookup; ancestors receive undefined because their context scope is not the source's. All 20 cases pass.

## Verification

`pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-runtime/permission-source.unit.test.ts`: 20 tests pass.

`pnpm exec eslint packages/ohbaby-agent/src/adapters/ui-runtime/permission-source.ts packages/ohbaby-agent/src/adapters/ui-runtime/permission-source.unit.test.ts`: no errors or warnings.

Tests cover trusted ancestry/real identities, source/middle/root deletion, missing parents/cycles/workspace mismatches/orphan children, canonical symlink roots, record consistency, immediate cancellation of unresolved reads, deletion before a node is discovered or while its read is pending, relation change during read, ordinary update isolation, scope-specific labels, and disposal without destroying the shared manager.

## Interface

`createPermissionSourcePort({ manager, bus, projectRoot, getSession, getSubagentRecord? })` returns `PermissionSourcePort extends PermissionPort` with `dispose(): void`.

`getSubagentRecord(session: Session, contextScopeId?: string)` returns `Promise<Pick<SubagentInstanceRecord, "sessionId" | "parentSessionId" | "name" | "description"> | null>`.

## Independent S1/S2 review

Read manager ownership/claim/critical commit order, scheduler permission entry points and post-answer cancellation checks, actual run identity forwarding, RunManager cancellation/finalization cleanup, and composition wrapper lifecycle. No blocking core finding remained. UI response cancellation and full snapshot/runId fallback remain scheduled S3/S4 work; they are not claimed complete by S1/S2 tests.

## Browser source-label correction

RED: the new two-context-scope unnamed-instance test received the shared session title instead of `Reject first`. GREEN: source labels now prefer the matched instance name, then description, then session title. All 21 source tests pass.
