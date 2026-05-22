# Agent Task Background Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a background AgentTask lifecycle and grouped control tools while preserving the current synchronous `task` child-session contract.

**Architecture:** Keep `task` as the synchronous opencode-style child-session tool. Add `agents/tasks` for AgentTask state and lifecycle, and add one grouped `tools/agent-task.ts` file that exposes `agent_open`, `agent_eval`, `agent_status`, and `agent_close`. Reuse the existing child session manager, message writer, subagent runner, context compaction, and RunManager cancellation path.

**Tech Stack:** TypeScript, Vitest, existing ohbaby-agent runtime managers, existing GLM smoke infrastructure.

---

## File Map

- Create: `packages/ohbaby-agent/src/agents/tasks/types.ts`
  - AgentTask status, records, controller interfaces, store contract.
- Create: `packages/ohbaby-agent/src/agents/tasks/in-memory-store.ts`
  - In-memory task store for runtime and unit tests.
- Create: `packages/ohbaby-agent/src/agents/tasks/manager.ts`
  - AgentTaskManager: open, eval, status, close, queue handling, cancellation.
- Create: `packages/ohbaby-agent/src/agents/tasks/index.ts`
  - Public exports for the task module.
- Create: `packages/ohbaby-agent/src/agents/tasks/manager.unit.test.ts`
  - Lifecycle tests for open/eval/status/close.
- Create: `packages/ohbaby-agent/src/tools/agent-task.ts`
  - Grouped tool definitions for `agent_open`, `agent_eval`, `agent_status`, `agent_close`.
- Create: `packages/ohbaby-agent/src/tools/agent-task.unit.test.ts`
  - Tool schema/adapter tests.
- Modify: `packages/ohbaby-agent/src/agents/index.ts`
  - Export AgentTask types/factory.
- Modify: `packages/ohbaby-agent/src/tools/builtin.ts`
  - Register grouped AgentTask tools when a controller is provided.
- Modify: `packages/ohbaby-agent/src/tools/index.ts`
  - Export grouped AgentTask tool factory.
- Modify: `packages/ohbaby-agent/src/core/tool-scheduler/constants.ts`
  - Add AgentTask tools to categories and subagent disabled list.
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`
  - Instantiate AgentTaskManager and register background tools.
- Modify targeted contract/smoke tests under `packages/ohbaby-agent/src/adapters` and `tests/smoke` as needed.

## Task 1: AgentTask Types And Store

- [ ] Create `agents/tasks/types.ts`.
- [ ] Define `AgentTaskStatus`.
- [ ] Define `AgentTaskRecord`.
- [ ] Define `AgentTaskStore`.
- [ ] Define `AgentTaskController` with `open`, `sendInput`, `get`, `close`.
- [ ] Create `agents/tasks/in-memory-store.ts`.
- [ ] Add unit tests proving create/get/update/list behavior.

Expected test command:

```powershell
pnpm vitest run packages/ohbaby-agent/src/agents/tasks/manager.unit.test.ts
```

Initial expected result: fail before implementation, pass after Task 2.

## Task 2: AgentTaskManager Lifecycle

- [ ] Write failing tests for `open` returning immediately while the runner is still pending.
- [ ] Write failing tests for a completed task moving to `completed` with output.
- [ ] Write failing tests for `sendInput` appending a child user turn and starting another run when idle.
- [ ] Write failing tests for `sendInput` queueing while running.
- [ ] Write failing tests for `close` aborting the active run and marking `cancelled`.
- [ ] Implement `AgentTaskManager`.

Core rules:

- `open` creates or resolves a child session through the existing runtime subagent session manager.
- `open` writes the child user message before starting the run.
- A task owns its own AbortController; parent run cancellation does not close background tasks.
- `sendInput(... interrupt: true)` aborts the active run, then schedules the new input.
- `close` is idempotent.

## Task 3: Grouped AgentTask Tools

- [ ] Create `tools/agent-task.ts`.
- [ ] Add `agent_open`, `agent_eval`, `agent_status`, `agent_close` in that single file.
- [ ] Add `tools/agent-task.unit.test.ts`.
- [ ] Register tools through `createBuiltinTools({ agentTaskController })`.
- [ ] Keep `tools/task.ts` unchanged except if type imports need to move.

Tool behavior:

- `agent_open`: starts a background child-session agent, returns task/session ids.
- `agent_eval`: sends follow-up input or queues it, returns status metadata.
- `agent_status`: returns status/output/pending count.
- `agent_close`: cancels and returns previous status.
- `agent_eval`, `agent_status`, and `agent_close` must be scoped to the parent
  session that opened the task.
- Retained background tasks must be bounded so a parent cannot fan out unlimited
  child runs.

## Task 4: Prevent Nested Subagents

- [ ] Add `agent_open`, `agent_eval`, `agent_status`, and `agent_close` to `SUBAGENT_DISABLED_TOOLS`.
- [ ] Register their category as `subagent`.
- [ ] Add/update tests proving subagents cannot see these tools.
- [ ] Add/update registry validation tests proving subagent configs cannot include them.

## Task 5: Runtime Composition

- [ ] Instantiate `AgentTaskManager` in `ui-runtime/composition.ts`.
- [ ] Reuse `agentManager`, `sessionManager`, `createSubagentMessageWriter`, and `subagentRunner`.
- [ ] Register grouped AgentTask tools alongside the existing synchronous `task`.
- [ ] Ensure `task` schema and output format remain compatible.

## Task 6: Contract And Integration Tests

- [ ] Add in-process contract test where parent model calls `agent_open`, later calls `agent_eval`, and checks `agent_status`.
- [ ] Add cancellation test where `agent_close` cancels a blocked child run.
- [ ] Keep existing sync `task` resume contract test passing.
- [ ] If practical, add persistent backend assertion that child sessions/messages/run ledger survive; AgentTask records may remain in-memory this round unless a durable store is implemented.
- [ ] Document that persistent child sessions survive restart, while the
      `task_id` control handle is in-memory for this round.

Targeted command:

```powershell
pnpm vitest run packages/ohbaby-agent/src/agents/tasks/manager.unit.test.ts packages/ohbaby-agent/src/tools/agent-task.unit.test.ts packages/ohbaby-agent/src/tools/task.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts
```

## Task 7: Real E2E Smoke

- [ ] Extend the existing gated real-provider smoke with background AgentTask flow.
- [ ] Use process-only environment key.
- [ ] Keep `baseUrl` normalized to `https://open.bigmodel.cn/api/paas/v4`.
- [ ] Keep `defaultModel` as `glm-5.1`.
- [ ] Scenario must include one synchronous `task` call and one background `agent_open` / `agent_eval` / `agent_status` / `agent_close` flow.

Command shape:

```powershell
$env:OHBABY_RUN_REAL_TUI_SMOKE="1"; $env:OHBABY_RUN_REAL_SUBAGENT_SMOKE="1"; $env:ZAI_API_KEY="<process only>"; pnpm vitest run tests/smoke/tui-real-provider.smoke.test.tsx
```

Do not write the key to any repo file or log.

## Task 8: Verification And Review

- [ ] Run `pnpm run lint`.
- [ ] Run `pnpm run typecheck`.
- [ ] Run targeted Vitest commands.
- [ ] Run `pnpm test`.
- [ ] Run real GLM smoke.
- [ ] Dispatch one code-review subagent over the feature diff.
- [ ] Dispatch one verification subagent over the test output and coverage.

## Task 9: Commit And Push

- [ ] Check `git status --short`.
- [ ] Stage only files changed for this feature.
- [ ] Confirm no API key is staged.
- [ ] Commit: `feat(agents): add background agent tasks`.
- [ ] Push `mvp`.

## Notes

- Do not implement team agents.
- Do not implement autonomous task claiming.
- Do not create a new worktree unless the user redirects.
- Existing untracked reference repos and problem-list docs remain untracked.
