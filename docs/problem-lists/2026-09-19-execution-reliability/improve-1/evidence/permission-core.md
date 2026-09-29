> Implementation working notes. Final acceptance is recorded in ../05-implementation-acceptance.md.

# improve-1 S1 permission core evidence

Branch: codex/improve-1-implementation; implementation started from 81cd4b00. No commit, push, or merge performed.

## Contract

PermissionAskInput requires a real runId, AbortSignal, and trusted PermissionSource. Frozen ancestorSessionIds excludes the actual source itself and includes every ancestor through root; root requests use []. PermissionInfo retains flattened immutable source identity. Adapter owns database/source verification; manager does not infer any execution ID or access session storage.

PermissionManager now owns an independent Map, bounded terminal identity cache (default 1024, no body/params), synchronous first-winner settlement, strict pending response validation, exact run cleanup, source/ancestor cleanup, and dispose. Current explicit deny is checked before all allows. Full Access admits future calls without manual approval or saved rules; changing level does not settle existing pending.

S3 injection contract: criticalCommit(PermissionCommit): void throws on critical failure, onCommitted(PermissionCommit): void runs after successful authoritative commit (and terminal record/Promise settlement for resolved), onUnavailable(rootSessionId | undefined, Error): void invalidates transports independently. Health is stored outside projection. Critical errors freeze the affected root and finish every wait without invoking broken projection again; shared freezeRuntime is explicit. Ordinary notification exceptions never change a valid decision. No S3 projection implementation is included.

## TDD evidence

1. RED: `pnpm exec vitest run packages/ohbaby-agent/src/permission/permission-lifecycle.unit.test.ts packages/ohbaby-agent/src/permission/evaluator.unit.test.ts` before manager/evaluator changes: 13 failed, 24 passed. Failures included no independent critical registration, ignored abort, unknown choice consumed, missing cleanup/terminal interfaces, root failure not propagated, deny bypassed by allow fast path, and sensitive Full Access still asking. Two rejection assertion errors reflected old code resolving instead of failing during injected critical failure. Full captured output: `/tmp/improve-1-permission-red.log`.
2. GREEN after implementation: same command, 37 passed, no errors.
3. RED for specialized notification port: lifecycle suite 1 failed, 23 passed; commit occurred but expected `onCommitted` ordering and duplicate-return observations were absent. Output: `/tmp/improve-1-permission-notify-red.log`.
4. GREEN after specialized notification implementation: lifecycle 24 passed.
5. Expanded regression coverage exercises response permutations, parent/sibling scope, nonrememberable pending, latest deny, frozen ancestors, registered vs existing-rule transitions, Full Access future-only behavior, missing IDs, registration failure, runtime isolation, duplicate IDs, rule storage errors, listener removal, cancellation immediately before registration, and preserving previously authorized rules after abort.

## Verification scope

Final permission directory tests: 90 passed across 6 files. Command: `pnpm exec vitest run packages/ohbaby-agent/src/permission/`.

Permission directory ESLint: `pnpm exec eslint packages/ohbaby-agent/src/permission/*.ts` passed without errors or warnings.

Full typecheck is coordinated by root; initial run had only external adapter/source fixtures and in-progress changes, no errors under permission/. Passing local tests do not claim S1+S2 integration gate or S3/S4 acceptance complete.

Changed files: permission/types.ts, manager.ts, events.ts, state.ts, evaluator.ts, index.ts, permission.unit.test.ts, permission-lifecycle.unit.test.ts, evaluator.unit.test.ts.
