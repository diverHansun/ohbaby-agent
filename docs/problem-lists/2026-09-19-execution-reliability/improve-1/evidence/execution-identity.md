> Implementation working notes. Final acceptance is recorded in ../05-implementation-acceptance.md.

# improve-1 execution identity / scheduler S1+S2 evidence

Scope: RunWorker -> lifecycle -> ModelStepParams -> scheduler request/call/execution context -> PermissionPort actual run identity, original call signal and context scope. Runner checks both stream and waitForCompletion creation identities; mismatches cancel actual run and invoke narrow revocation hook before any completion wait. Standalone calls remain supported but cannot interactively ask without runId. Full Access explicit/external write asks now follow D22; evaluator-sensitive bypass implemented by permission agent.

TDD: `/tmp/improve-1-identity-red.log` showed missing runId across scheduler, lifecycle and worker; missing mismatch cancellation in both wait modes; standalone ask erroneously proceeded; old Full Access asks violated revised expectations. 11 failures included 3 concurrently added parent manager tests. Implementation followed these failures.

Verification:

- `pnpm exec vitest run packages/ohbaby-agent/src/core/agents/runner.unit.test.ts packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts tests/integration/core/tool-scheduler-permission.integration.test.ts`: 176 passed before final run A/B case; `/tmp/improve-1-identity-verified.log`.
- Scheduler+manager integration: 21 passed after run A/B case; real manager, no projection. Ordinary, explicit MCP, skill, external read/write original call cancellation; pre-abort and before-ask microtask; same-call external then bash independent approval IDs; valid always survives later cancellation/rejection; Full Access cases plus deny/validation.
- Adjacent lifecycle integrations: lifecycle-tool-scheduler, dynamic-tools, failed-history passed. Existing bash integration harness updated with explicit real test run and source wrapper; then 4 bash tests passed.
- Final focused suites after formatting: 131 passed across runner (16), lifecycle (52), scheduler (59), bash integration (4); `/tmp/improve-1-final-suites.log`.
- `pnpm exec tsc -b --pretty false`: passed, `/tmp/improve-1-typecheck-final.log` empty.
- `git diff --check`: passed.

Review: scheduler carries opaque IDs only; no session/database dependency or inferred active run. Single existing ask helper performs identity/signal binding for every permission entrance. Runner revocation uses narrow coordinator hook rather than coupling core agents to manager. Independently inspected manager claim-before-side-effects, frozen source ancestry, signal rechecks and source wrapper invalidation; no blocking issue found. Full S3/S4 transport/UI/E2E are outside this subtask. No commits or pushes.
