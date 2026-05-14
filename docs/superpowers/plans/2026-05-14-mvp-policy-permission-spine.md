# MVP Policy Permission Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the lint quality gate and add the MVP policy + permission control plane used by `core/tool-scheduler`.

**Architecture:** Keep `core/tool-scheduler` as the execution orchestrator and add narrow `policy` and `permission` modules behind its existing ports. `policy` owns deterministic mode decisions and events; `permission` owns queued ask/respond flow, session-scoped approvals, and events. Cross-module behavior is verified with integration tests using real `Bus`, `Policy`, `Permission`, and `ToolScheduler` with fake tools only.

**Tech Stack:** TypeScript, pnpm, Vitest, ESLint, existing `BusEvent` + Zod event definitions.

---

## File Map

- Modify: `packages/ohbaby-agent/src/config/llm/__tests__/validation.test.ts`
  - Convert void-returning arrow shorthand assertions into block bodies.
- Modify: `packages/ohbaby-agent/src/config/llm/manager.ts`
  - Remove empty-constructor/no-unnecessary-assertion lint issues without changing behavior.
- Modify: `packages/ohbaby-agent/src/config/llm/types.ts`
  - Make `Error.captureStackTrace` check lint-clean.
- Modify: `packages/ohbaby-agent/src/config/llm/validation.ts`
  - Make numeric template literal diagnostics lint-clean.
- Create: `packages/ohbaby-agent/src/policy/types.ts`
  - Public `Mode`, `AgentState`, `PolicyDecision`, `PolicyManager`, and check input types.
- Create: `packages/ohbaby-agent/src/policy/events.ts`
  - `policy.mode-changed` and `policy.agent-state-changed` event definitions.
- Create: `packages/ohbaby-agent/src/policy/manager.ts`
  - Deterministic mode/state manager and `PolicyPort` compatible `check`.
- Create: `packages/ohbaby-agent/src/policy/index.ts`
  - Public exports and default singleton facade.
- Create: `packages/ohbaby-agent/src/policy/policy.unit.test.ts`
  - Matrix, state, and event unit tests.
- Create: `packages/ohbaby-agent/src/permission/types.ts`
  - Public ask input, info, response, manager, errors.
- Create: `packages/ohbaby-agent/src/permission/events.ts`
  - `permission.updated`, `permission.replied`, and `permission.switch-mode-requested`.
- Create: `packages/ohbaby-agent/src/permission/matcher.ts`
  - Pattern generation and matching helpers.
- Create: `packages/ohbaby-agent/src/permission/manager.ts`
  - Queued ask/respond implementation with session approvals.
- Create: `packages/ohbaby-agent/src/permission/index.ts`
  - Public exports and default singleton facade.
- Create: `packages/ohbaby-agent/src/permission/permission.unit.test.ts`
  - Queue, response, auto-approval, pattern, and session isolation tests.
- Create: `tests/integration/core/tool-scheduler-policy-permission.integration.test.ts`
  - Real scheduler-policy-permission collaboration tests.
- Modify: `packages/ohbaby-agent/src/index.ts`
  - Export `policy` and `permission` public modules.

---

## Task 1: Restore config/llm lint gate

- [ ] Run `pnpm run lint` and record the existing lint failures.
- [ ] Apply only lint-preserving edits to `config/llm`.
- [ ] Run `pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__/validation.test.ts packages/ohbaby-agent/src/config/llm/__tests__/manager.test.ts`.
- [ ] Run `pnpm run lint`.
- [ ] Commit as `chore(config/llm): clear lint debt`.
- [ ] Dispatch a review subagent for this commit.

## Task 2: Add policy module

- [ ] Write failing unit tests for default mode/state, mode cycling, state reset, decision matrix, invalid category denial, and Bus events.
- [ ] Run `pnpm exec vitest run packages/ohbaby-agent/src/policy/policy.unit.test.ts` and confirm failure because the module does not exist.
- [ ] Implement minimal `policy` files and exports.
- [ ] Run policy unit tests, `pnpm run typecheck`, and `pnpm run lint`.
- [ ] Commit as `feat(policy): add MVP mode decision manager`.
- [ ] Dispatch a review subagent for this commit.

## Task 3: Add permission module

- [ ] Write failing unit tests for ask pending behavior, once/always/reject/cancel/suggest responses, queue serialization, auto-approval, session cleanup, and pattern matching.
- [ ] Run `pnpm exec vitest run packages/ohbaby-agent/src/permission/permission.unit.test.ts` and confirm failure because the module does not exist.
- [ ] Implement minimal `permission` files and exports.
- [ ] Run permission unit tests, `pnpm run typecheck`, and `pnpm run lint`.
- [ ] Commit as `feat(permission): add queued approval manager`.
- [ ] Dispatch a review subagent for this commit.

## Task 4: Integrate real policy and permission with tool-scheduler

- [ ] Write failing integration tests under `tests/integration/core/` using real `createToolScheduler`, `createPolicyManager`, `createPermissionManager`, and `createBus`.
- [ ] Cover Agent ask-before-edit write approval, always approval switching policy to edit-automatically, Plan mode write denial, and Ask mode readonly-only behavior.
- [ ] Run `pnpm test:integration` and confirm failure before wiring any missing compatibility.
- [ ] Add only adapter/wiring code needed for `ToolSchedulerOptions.policy` and `.permission`.
- [ ] Run `pnpm test:integration`, `pnpm test:unit`, `pnpm run typecheck`, and `pnpm run lint`.
- [ ] Commit as `test(core): cover scheduler policy permission spine`.
- [ ] Dispatch a review subagent for this commit.

## Task 5: Final validation

- [ ] Run `pnpm test:unit`.
- [ ] Run `pnpm test:integration`.
- [ ] Run `pnpm run typecheck`.
- [ ] Run `pnpm run lint`.
- [ ] Run `pnpm test`.
- [ ] Review `git diff mvp...HEAD`.
- [ ] Summarize commits and merge readiness.

---

## Design Notes

- Keep `policy` synchronous and deterministic; async behavior belongs to `permission` and `tool-scheduler`.
- Let `permission.ask()` resolve to the scheduler's current `PermissionResponse` string union for compatibility, while preserving richer response data in Bus events.
- Use opencode's useful shape, not its framework: a pending request map/queue, explicit Bus events, and session-scoped approvals.
- Do not implement `utils/command-parser`, `utils/paths`, `project`, `sandbox`, `shell`, `tools v1`, or lifecycle tool loop in this branch.
