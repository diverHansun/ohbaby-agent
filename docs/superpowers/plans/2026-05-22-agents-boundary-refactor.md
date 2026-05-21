# Agents Boundary Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the synchronous child-session subagent runtime glue out of `ui-runtime/composition.ts` and into focused `agents` helpers without changing `task` behavior.

**Architecture:** `agents` owns subagent execution boundaries: session adapters, child message writing, and the child runner factory. `ui-runtime/composition.ts` remains the composition root that wires concrete managers, schedulers, sandbox, and run manager together.

**Tech Stack:** TypeScript, Vitest, pnpm, existing RunManager/ToolScheduler/MessageManager/SessionManager abstractions.

---

## Task 1: Document Current Boundary

**Files:**
- Modify: `docs/agents/architecture.md`
- Modify: `docs/agents/context-isolation.md`

- [ ] Add a short "Current boundary" note: this phase keeps `task` synchronous and child-session based.
- [ ] Explicitly mark Claude Code-style background/team/autonomous agents as future work.
- [ ] Mention that agent `permission` config is defined but not yet applied as a runtime policy override.

## Task 2: Extract Subagent Session Adapters

**Files:**
- Create: `packages/ohbaby-agent/src/agents/session-manager.ts`
- Create: `packages/ohbaby-agent/src/agents/session-manager.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/agents/index.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`

- [ ] Move the in-memory and persistent child-session adapters out of composition.
- [ ] Export `RuntimeSubagentSessionManager`, `InMemorySubagentSessionManager`, `PersistentSubagentSessionManager`, and `createRuntimeSubagentSessionManager`.
- [ ] Preserve `ensureRoot()`, parent-child linkage, child project root inheritance, and persistent `SessionManager.create/get` delegation.

## Task 3: Extract Message Writer and Runner Factory

**Files:**
- Create: `packages/ohbaby-agent/src/agents/message-writer.ts`
- Create: `packages/ohbaby-agent/src/agents/message-writer.unit.test.ts`
- Create: `packages/ohbaby-agent/src/agents/runner.ts`
- Create: `packages/ohbaby-agent/src/agents/runner.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/agents/index.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`

- [ ] Move child user/assistant message writing into `createSubagentMessageWriter()`.
- [ ] Move child run creation, abort binding, sandbox set/cleanup, and last assistant text extraction into `createSubagentRunner()`.
- [ ] Keep the existing result shape: final assistant text if present, otherwise completion error, `steps: 0`, `toolCalls: []`.

## Task 4: Clarify Prompt/Config Boundary

**Files:**
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`
- Modify: `packages/ohbaby-agent/src/config/agents/types.ts`
- Modify: `packages/ohbaby-agent/src/config/agents/__tests__/validation.test.ts`

- [ ] Rename the shared prompt builder inside composition to make primary/subagent use explicit.
- [ ] Add `prompt` to `AgentConfigSchema`, matching `agents/types.ts` and builtin subagent usage.
- [ ] Keep `permission` as a config field only; do not change runtime policy behavior in this phase.

## Task 5: Verify, Review, Commit, Push

**Files:**
- No additional source files.

- [ ] Run targeted tests for agents, config/agents, in-process contract, persistent integration, and session stores.
- [ ] Run `pnpm run lint`, `pnpm run typecheck`, and `pnpm test`.
- [ ] Run the gated real GLM subagent smoke with the key only in process environment.
- [ ] Dispatch one code-review subagent and one verification subagent over the final diff and test output.
- [ ] Stage only files touched by this plan, commit `refactor(agents): extract subagent runtime boundaries`, and push `mvp`.
