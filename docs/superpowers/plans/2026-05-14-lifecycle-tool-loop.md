# Lifecycle Tool Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通 `RunWorker -> Lifecycle -> ToolScheduler -> Tool.execute()` 的 MVP 工具执行主链路，不实现任何具体内置工具。

**Architecture:** `core/tool-scheduler` 定义最小工具运行环境抽象，`runtime/run-manager` 将 `SandboxLease` 适配成该抽象并传入 `Lifecycle`。`Lifecycle` 只编排 LLM stream、工具调用、工具结果消息和下一轮 LLM 输入，不 import `runtime/*` 或 `sandbox/*`。

**Tech Stack:** TypeScript, Vitest, pnpm, OpenAI-compatible chat message DTOs, existing `MessageManager`, existing `ToolScheduler`.

---

## File Map

- Modify `packages/ohbaby-agent/src/core/tool-scheduler/types.ts`: add `ToolExecutionEnvironment`, `ToolCommandContext`, and pass it through `ToolExecutionContext` / `ToolCallRequest`.
- Modify `packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts`: forward `request.environment` into `tool.execute()` context.
- Modify `packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts`: verify tools can observe the injected environment.
- Modify `packages/ohbaby-agent/src/core/lifecycle/types.ts`: add `toolScheduler`, tool-call id generation, max step controls, environment param, and lifecycle tool events.
- Modify `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts`: implement multi-step LLM/tool loop, message `ToolPart` writes, tool result formatting, and next LLM input assembly.
- Modify `packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts`: add no-tool regression, one-tool two-step loop, and error/rejected result loop coverage.
- Modify `packages/ohbaby-agent/src/runtime/run-manager/types.ts`: extend the local `SandboxLease` shape enough for lease-to-core adaptation.
- Modify `packages/ohbaby-agent/src/runtime/run-manager/worker.ts`: adapt lease into core environment and publish tool start/result events to `StreamBridge`.
- Modify `packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts`: verify lifecycle receives environment and stream bridge receives tool events.
- Add `tests/integration/core/lifecycle-tool-scheduler.integration.test.ts`: fake LLM + fake tool + real scheduler/policy/permission allow, verifying full loop.

## Design Notes

- Tool call results with `error`, `rejected`, or `cancelled` are converted into tool-role messages and returned to the next model step. This follows the lifecycle docs' recoverable tool-error semantics and avoids turning a single failed tool into an unrecoverable lifecycle failure.
- `signal.aborted` remains an execution stop condition. A run abort can still cause scheduler results to be `cancelled`, but the outer run manager already maps aborted runs to cancelled terminal status.
- `LifecycleRunParams.messages` remains the source of initial model history. Within one lifecycle run, tool call assistant messages and tool result messages are appended to an in-memory `conversationMessages` array to preserve OpenAI-compatible role ordering.
- Persistent `MessageManager` writes stay in existing message/part types: assistant text as `TextPart`, tool calls/results as `ToolPart` state transitions.
- The core environment abstraction is intentionally small and structural. Runtime can supply a real sandbox lease adapter; unit and integration tests can supply fake environments.

---

### Task 1: ToolScheduler Runtime Environment Context

**Files:**
- Modify `packages/ohbaby-agent/src/core/tool-scheduler/types.ts`
- Modify `packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts`
- Modify `packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts`

- [ ] **Step 1: Write failing scheduler unit test**

Add a test proving a tool receives `context.environment.workdir` and can call `resolveCommandContext()`.

Run:

```bash
pnpm exec vitest run packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts
```

Expected: TypeScript/test failure because `environment` is not part of `ToolCallRequest` or `ToolExecutionContext`.

- [ ] **Step 2: Add core environment types**

Add a core-owned abstraction in `types.ts`:

```ts
export interface ToolCommandContext {
  readonly kind: string;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly commandPrefix?: readonly string[];
}

export interface ToolCommandContextOptions {
  readonly fileAccess?: "none" | "workspace-ro" | "workspace-rw";
}

export interface ToolExecutionEnvironment {
  readonly workdir: string;
  resolvePath(inputPath: string): string;
  resolvePathForExisting(inputPath: string): Promise<string>;
  resolvePathForWrite(inputPath: string): Promise<string>;
  resolveCommandContext(options?: ToolCommandContextOptions): ToolCommandContext;
}
```

Then add `environment?: ToolExecutionEnvironment` to `ToolExecutionContext` and `ToolCallRequest`.

- [ ] **Step 3: Forward environment in scheduler**

Pass `request.environment` through `executeToolWithTimeout()` into `tool.execute()` context.

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm exec vitest run packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts
pnpm run lint
git add packages/ohbaby-agent/src/core/tool-scheduler
git commit -m "feat(agent): pass tool runtime environment through scheduler"
```

Request subagent review for this commit before continuing.

### Task 2: Lifecycle Multi-Step Tool Loop

**Files:**
- Modify `packages/ohbaby-agent/src/core/lifecycle/types.ts`
- Modify `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts`
- Modify `packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts`

- [ ] **Step 1: Write failing lifecycle unit tests**

Add tests for:

- no-tool response keeps the current event order and return value
- single parsed tool call invokes injected scheduler and triggers a second LLM request
- rejected/error/cancelled tool result is written as a tool result and passed to the next LLM request

Run:

```bash
pnpm exec vitest run packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts
```

Expected: failures because `LifecycleDeps.toolScheduler`, tool events, and multi-step loop do not exist.

- [ ] **Step 2: Extend lifecycle public types**

Add:

- `LifecycleDeps.toolScheduler?`
- `LifecycleDeps.generateToolCallId?`
- `LifecycleRunParams.environment?`
- `LifecycleRunParams.maxSteps?`
- lifecycle events `tool:start`, `tool:result`, `step:complete`

Keep all existing event payloads stable.

- [ ] **Step 3: Implement model message helpers**

Add internal helpers to:

- build assistant messages with `tool_calls`
- stringify parsed tool arguments for raw OpenAI function call payloads
- format `ToolCallResult` into tool message content
- map scheduler final statuses to `ToolPart` states

- [ ] **Step 4: Implement loop**

For each step:

1. create an assistant message record for that step when `MessageManager` is present
2. stream LLM response and yield existing LLM events
3. if no tool calls, mark message complete and return success
4. if tool calls exist, append/update `ToolPart` records, yield `tool:start`, call `executeBatch()`, update parts, yield `tool:result`
5. append assistant tool-call message and tool result messages to in-memory history
6. yield `step:complete` and continue

When `maxSteps` is reached, return `success: false`, `finishReason: "error"`, and a clear final response explaining the max step limit.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm exec vitest run packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts
pnpm run lint
git add packages/ohbaby-agent/src/core/lifecycle
git commit -m "feat(agent): execute scheduled tools from lifecycle loop"
```

Request subagent review for this commit before continuing.

### Task 3: RunWorker Sandbox Environment Adaptation and Tool Events

**Files:**
- Modify `packages/ohbaby-agent/src/runtime/run-manager/types.ts`
- Modify `packages/ohbaby-agent/src/runtime/run-manager/worker.ts`
- Modify `packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts`

- [ ] **Step 1: Write failing run-manager unit tests**

Add tests proving:

- `LifecycleRunParams.environment.workdir` is passed from a sandbox lease with path APIs
- lifecycle `tool:start` and `tool:result` events are published to `streamBridge`

Run:

```bash
pnpm exec vitest run packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts
```

Expected: failures because worker does not adapt the lease and ignores tool events.

- [ ] **Step 2: Extend run-manager lease shape**

Update the local `SandboxLease` interface structurally with optional path and command-context methods matching core environment semantics. This keeps `runtime/run-manager` decoupled from `src/sandbox`.

- [ ] **Step 3: Add adapter in worker**

Create a private helper that returns a `ToolExecutionEnvironment` only when `workdir` and all required methods exist on `context.sandboxLease`.

- [ ] **Step 4: Publish tool events**

Map lifecycle events to stream bridge names:

- `tool:start` -> `run.tool.start`
- `tool:result` -> `run.tool.result`

Payload includes `runId`, `sessionId`, `timestamp`, `callId`, `toolName`, and result/status data.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm exec vitest run packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts
pnpm run lint
git add packages/ohbaby-agent/src/runtime/run-manager
git commit -m "feat(agent): pass sandbox tool environment from run worker"
```

Request subagent review for this commit before continuing.

### Task 4: Core Integration Test

**Files:**
- Add `tests/integration/core/lifecycle-tool-scheduler.integration.test.ts`

- [ ] **Step 1: Write integration test**

Use:

- fake streaming LLM provider with two requests
- real `createToolScheduler()`
- real policy port returning allow
- no real permission prompt because policy allows
- fake registered tool returning deterministic output and asserting `context.environment`

Verify:

- first LLM call receives original user message
- fake tool executes once
- second LLM call receives assistant `tool_calls` and `tool` result messages
- final lifecycle result is `success: true`, `finishReason: "stop"`

- [ ] **Step 2: Run integration test and fix issues**

Run:

```bash
pnpm exec vitest run tests/integration/core/lifecycle-tool-scheduler.integration.test.ts
```

- [ ] **Step 3: Verify and commit**

Run:

```bash
pnpm test:unit
pnpm test:integration
pnpm run typecheck
pnpm run lint
git add tests/integration/core/lifecycle-tool-scheduler.integration.test.ts
git commit -m "test(agent): cover lifecycle scheduler tool loop integration"
```

Request subagent review for the full feature branch.

### Task 5: Final Verification

**Files:** none expected.

- [ ] **Step 1: Run final checks**

Run:

```bash
pnpm test:unit
pnpm test:integration
pnpm run typecheck
pnpm run lint
```

- [ ] **Step 2: Inspect git history and diff**

Run:

```bash
git status --short
git log --oneline --decorate -5
git diff --stat mvp...HEAD
```

- [ ] **Step 3: Prepare merge-ready summary**

Report:

- worktree path
- branch name
- commit list
- test results
- review findings and resolutions
- any known residual risks
