# Phase 2 Execution Plan: Split In-Process UI Backend

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for new extracted modules and `superpowers:verification-before-completion` before every completion claim. This plan is scoped to Phase 2 only.

**Goal:** Split the large in-process UI backend into focused internal modules without changing Phase 1 behavior.

**Architecture:** Keep `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` as the public assembly entry so existing imports of `./ui-inprocess.js` keep working. Move behavior behind explicit controllers under `packages/ohbaby-agent/src/adapters/ui-inprocess/`. Contract tests remain the behavioral source of truth.

**Tech Stack:** TypeScript, Vitest, existing `UiBackendClient` contract, existing in-process runtime composition.

---

## Scope

Phase 2 is refactoring only. It must not introduce daemon behavior, cross-terminal FIFO, new CLI flags, or new user-visible semantics.

## Target Files

Create:

- `packages/ohbaby-agent/src/adapters/ui-inprocess/types.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess/session-controller.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess/session-controller.unit.test.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess/prompt-controller.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess/prompt-controller.unit.test.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess/runtime-controller.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess/runtime-controller.unit.test.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess/event-router.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess/event-router.unit.test.ts`

Modify:

- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`
- `docs/problem-lists/terminal-daemon/05-implementation-plan.md`

## Task 2.1: Characterization Tests

- [ ] Add focused contract coverage for session command creation/reuse, prompt session creation/reuse, rename/delete active session, successful prompt submission, abort, and local queued prompt behavior where gaps remain.
- [ ] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts --no-file-parallelism
```

- [ ] Commit: `test(agent): characterize in-process ui backend`

## Task 2.2: Extract Session Controller

- [ ] Write failing unit tests for `resolveSessionForNewPrompt`:
  - reuses empty active session for the same project.
  - skips non-empty active session.
  - reuses core empty primary session.
  - reuses UI empty session.
  - creates a new session when no reusable session exists.
- [ ] Implement `session-controller.ts` with explicit dependencies rather than passing the full backend options object.
- [ ] Move empty-session reuse helpers out of `ui-inprocess.ts`.
- [ ] Ensure `findReusableEmptyPrimary` and UI empty-session lookup are called from one controller path.
- [ ] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess/session-controller.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts --no-file-parallelism
```

- [ ] Commit: `refactor(agent): extract session controller`

## Task 2.3: Extract Prompt And Runtime Controllers

- [ ] Write failing unit tests for prompt queue binding:
  - first prompt runs immediately.
  - second prompt inherits active session when queued during an active prompt.
  - sequential awaited prompt without session still creates a new session.
  - close rejects pending queued prompts.
- [ ] Move prompt queue binding into `prompt-controller.ts`.
- [ ] Write unit tests for runtime controller:
  - runtime is lazy-created once.
  - runtime creation errors update status and publish a notice through injected callbacks.
  - abort only targets the local active run.
- [ ] Move runtime creation, runtime-for-prompt handling, active run status reconciliation, and abort helpers into `runtime-controller.ts`.
- [ ] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess/prompt-controller.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess/runtime-controller.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts --no-file-parallelism
```

- [ ] Commit: `refactor(agent): extract prompt runtime controllers`

## Task 2.4: Extract Event Router

- [ ] Write unit tests for app-event routing:
  - event handlers are isolated from handler exceptions.
  - snapshot replacement is published after routed state changes.
  - unsubscribe stops delivery.
- [ ] Move event handler set, publish helper, notice publishing, and bus subscription cleanup into `event-router.ts`.
- [ ] Keep `ui-inprocess.ts` as a composition module that wires controllers and returns `UiBackendClient`.
- [ ] Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess/event-router.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts --no-file-parallelism
```

- [ ] Commit: `refactor(agent): extract ui event router`

## Phase 2 Verification

- [ ] `pnpm run lint`
- [ ] `pnpm run typecheck`
- [ ] `pnpm run build`
- [ ] `pnpm test:unit`
- [ ] `pnpm test:integration`
- [ ] `pnpm test:e2e:snapshot`
- [ ] `pnpm test:smoke:real`
- [ ] Request subagent code review focused on behavior drift, controller boundaries, circular imports, and Phase 3 readiness.
- [ ] Update `docs/problem-lists/terminal-daemon/05-implementation-plan.md` Phase 2 checkboxes.
- [ ] Commit final docs/review note if needed.
