# Agent Task Background Design

## Goal

Add a Claude Code / Codex style agent task control layer while preserving the
current opencode-style synchronous `task` child-session behavior.

This round implements phases 1-5 only:

- Agent task lifecycle.
- Tool entrypoints for background agent control.
- Parent-to-child follow-up input.
- Cancellation / close.
- Status, progress, and output retrieval.

This round intentionally excludes team agents, named team inboxes, task
claiming, and autonomous loops.

## Reference Findings

### Current ohbaby-agent

`packages/ohbaby-agent/src/tools/task.ts` is not an AgentTask module. It is a
thin tool adapter:

- validates `agent_name`, `prompt`, `description`, and `resume_session_id`;
- calls an injected `TaskExecutor`;
- returns the subagent output and `metadata.subagent`.

That shape is useful and should remain thin.

The real synchronous child-session lifecycle currently lives under
`packages/ohbaby-agent/src/agents`:

- `SubagentExecutor` resolves the agent, session, and resume checks.
- `session-manager.ts` adapts persistent or in-memory child sessions.
- `message-writer.ts` writes child user/error assistant turns.
- `runner.ts` binds child runs to `RunManager`.

### Codex

Codex splits multi-agent control into explicit tools: `spawn_agent`,
`send_input`, `wait_agent`, `list_agents`, `resume_agent`, and `close_agent`.
The source also has a root-scoped `AgentControl` that owns spawn/message/close
operations for a thread tree. Important patterns to borrow:

- A subagent is a live agent thread, not only a one-off tool call.
- Spawn returns an identifier; follow-up input targets that identifier.
- Wait/status is separate from spawn.
- Close releases the live agent and descendants.
- The implementation enforces spawn slots and depth limits.

Sources:

- `https://github.com/openai/codex/blob/main/codex-rs/tools/src/agent_tool.rs`
- `https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/control.rs`
- `https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/registry.rs`
- `https://developers.openai.com/codex/concepts/subagents`

### Claude Code

Claude Code exposes a richer AgentTool surface, including synchronous agents,
background agents, resumption, output files, foreground-to-background
transition, and worktree/fork behavior. Important patterns to borrow:

- Separate synchronous completion from background task lifecycle.
- Store a durable task id / agent id for later interaction.
- Track progress and expose output independently of the parent transcript.
- Make background agent cancellation explicit.

We should not copy Claude Code's large single AgentTool file shape. It carries
too many responsibilities in one module.

### opencode

opencode keeps `task` close to the child-session model. Important patterns to
keep:

- Child sessions are real sessions with `parentID`.
- Resume appends a new user prompt to the same child session.
- Context assembly and compaction are session scoped.
- The parent receives only tool result and metadata, not child transcript.

## Design Decisions

### 1. Tool file layout

Do not add flat files like `tools/agent-open.ts`, `tools/agent-eval.ts`, and
`tools/agent-close.ts`.

Use one grouped tool module:

- `packages/ohbaby-agent/src/tools/agent-task.ts`

That file exports all AgentTask control tools:

- `agent_open`
- `agent_eval`
- `agent_status`
- `agent_close`

Reason: the schemas share validation helpers, output formatting, and one
controller interface. Keeping these together makes the tool surface easier to
understand. The lifecycle implementation still belongs in
`packages/ohbaby-agent/src/agents/tasks`.

Keep the existing synchronous tool:

- `packages/ohbaby-agent/src/tools/task.ts`

Reason: `task` is already stable and represents a different semantic contract:
run a focused child-session task and return the result synchronously.

### 2. Task compatibility

Preserve the current `task` schema and return format.

Reasons:

- Existing tests and real smoke prompts depend on `agent_name`, `prompt`, and
  `resume_session_id`.
- Existing transcripts may replay old tool calls.
- The model already understands `task` as a synchronous child-session tool.

The new AgentTask layer may later power `task` internally, but this round should
not change public `task` behavior.

### 3. Subagent nesting

Subagents cannot create subagents or background agents in this round.

Implementation:

- Keep `task` in `SUBAGENT_DISABLED_TOOLS`.
- Add `agent_open`, `agent_eval`, `agent_status`, and `agent_close` to
  `SUBAGENT_DISABLED_TOOLS`.
- Registry validation must reject subagent configs that explicitly include
  these tools.

Reason: this matches the user's desired constraint and avoids recursive process
trees before team/autonomous lifecycle rules exist.

### 4. AgentTask lifecycle

Introduce `AgentTaskManager` under `packages/ohbaby-agent/src/agents/tasks`.

Conceptual states:

- `pending`: task created but not yet running.
- `running`: a child run is active.
- `idle`: task has a live child session and can receive follow-up input.
- `completed`: task produced a final answer and no pending input remains.
- `failed`: last run failed.
- `cancelled`: task was closed or aborted.
- `blocked`: reserved for future permission blocking.

For this round, `completed` tasks can still be resumed by `agent_eval`; doing so
moves the task back to `running`.

### 5. Background behavior

`agent_open` creates a child session and starts a child run without waiting for
completion. It returns a task id and session id immediately.

`agent_eval` appends a new user prompt to the existing child session. If the
task is idle/completed/failed, it starts a new child run. If the task is
running, it queues the input for the next run. If `interrupt` is true, it aborts
the active run and then runs the new input.

`agent_status` returns task status, output, pending input count, and child
session metadata.

`agent_close` aborts the active run if present and marks the task cancelled.

The control plane is parent-session owned: `agent_eval`, `agent_status`, and
`agent_close` only operate on tasks opened by the current parent session.

To prevent uncontrolled fan-out, retained background tasks are capped in this
round. A parent session must close an older task before opening more than the
configured retained-task limit.

If the parent tool call is already aborted while `agent_open` is still setting
up, no background child run is started. After `agent_open` returns a task id,
background task cancellation is explicit through `agent_close`.

### 6. Output

This round stores output in task state and metadata. If a durable output file is
easy to wire through the existing runtime, add it. Otherwise keep output in the
task record and expose it through `agent_status`.

The parent context receives only tool outputs/metadata, not child transcripts.

AgentTask control records are intentionally in-memory in this round. Persistent
backends still persist child sessions, child transcripts, and child run ledger
entries, but restarting the runtime does not preserve the `task_id` control
handle. A database-backed AgentTask store is deferred to the next lifecycle
round.

### 7. Real provider testing

Use the existing GLM real provider smoke style:

- Set API key only in the process environment.
- Use `baseUrl: "https://open.bigmodel.cn/api/paas/v4"`.
- Use `defaultModel: "glm-5.1"`.

Scenarios:

- Main agent calls synchronous `task`.
- Main agent calls `agent_open`.
- Main agent follows up with `agent_eval`.
- A long-running background task is cancelled with `agent_close`.

## Open Non-Goals

- No team agents.
- No autonomous task claiming.
- No worktree-per-agent isolation.
- No live streaming UI panel beyond task status metadata.
- No subagent-created subagents.

## Success Criteria

- Existing `task` tests and smoke tests keep passing.
- New AgentTask tools are grouped in one tool file.
- Subagents do not see or invoke AgentTask control tools.
- Background agent can be opened, followed up, checked, and closed.
- Parent abort still cancels synchronous `task`; background agent close is
  explicit.
- Unit, integration, full test suite, real E2E, and subagent review pass before
  commit.
