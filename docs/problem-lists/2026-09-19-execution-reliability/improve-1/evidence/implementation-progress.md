> Implementation working notes. Final acceptance is recorded in ../05-implementation-acceptance.md.

# improve-1 execution ledger

Plan: docs/problem-lists/2026-09-19-execution-reliability/improve-1/02-optimization-plan-and-change-scope.md
Base: 81cd4b00; branch: codex/improve-1-implementation; current checkout (no worktree).
User scope: implement S1-S4, unit/integration/actual browser and PTY E2E with .env models, subagent reviews, then Pi github-copilot/claude-opus-5.5 review; batch commit only after verification. No merge/push.
Shared previous discussion read through Playwright: source deletion during async resolution race required; Full Access applies future admission, existing pending retained.
Baseline permission+tool scheduler integration 24/24 pass.
S1 core: permission_core agent in progress; types/source/criticalCommit agreed.
S1/S2 identity: execution_identity agent in progress; no-run asks fail explicitly.
S2 source wrapper: permission_source agent in progress; frozen source, ancestor deletion race.
S2 run manager: root added terminal/cancel revoke hook, 3 new tests observed fail then pass (runId worker assertion belongs identity agent and currently red).
S1+S2 internal gate passed:287 tests13files and typecheck; S3/S4 in progress. Actual composition lifecycle now6 passing incl primary stream and child foreground run identity mismatch cleanup.
Pi preflight: help/list/models checked; github-copilot claude-opus-5.5 auth ready. No Pi review invoked yet.
