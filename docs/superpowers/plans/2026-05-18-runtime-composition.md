# Runtime Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the temporary `ui-inprocess.ts` run loop with the real `Session/Message -> AgentManager -> RunManager -> Lifecycle -> ToolScheduler -> StreamBridge -> UiEvent/UiSnapshot` chain.

**Architecture:** Keep `ui-inprocess.ts` as the SDK-facing adapter and move runtime wiring plus run-stream projection into focused `adapters/ui-runtime/*` modules. `RunManager` owns run IDs, ledger transitions, sandbox leases, lifecycle execution, and stream publication; the UI adapter only creates SDK session/message records, starts a run, consumes `StreamBridge` events, and updates the in-memory UI snapshot. Builtin tools must be registered with `createBuiltinTools({ taskExecutor })`, and `ToolSchedulerOptions.agentTools` must point at `AgentManager`.

**Tech Stack:** TypeScript, Vitest, `RunManager`, `InMemoryRunLedger`, `InMemoryStreamBridge`, `AgentManager`, `SubagentExecutor`, `Lifecycle`, `ToolScheduler`.

---

## File Structure

- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
  - Keep `UiBackendClient` API and command/permission handling.
  - Remove direct `Lifecycle.run()` consumption and local run status fabrication.
  - Delegate runtime construction and run-stream projection to `adapters/ui-runtime/*`.
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`
  - Preserve existing contract tests.
  - Add RunManager/ledger proof and agent tool filter proof.
- Create: `packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.ts`
  - Move host-local path and command-context environment helpers out of `ui-inprocess.ts`.
  - Export a minimal `SandboxManager` that returns the host-local environment shape as a `SandboxLease`.
- Create: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`
  - Compose `AgentManager`, `SubagentExecutor`, `createBuiltinTools({ taskExecutor })`, `ToolScheduler`, `Lifecycle`, `RunManager`, `InMemoryRunLedger`, and `InMemoryStreamBridge`.
  - Expose `ready`, `agentManager`, `toolScheduler`, `runManager`, `runLedger`, `streamBridge`, `reserveRunId()`, `listToolSummaries()`, and `ensureSessionRecord()`.
- Create: `packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts`
  - Consume a single `run/<id>` stream from `StreamBridge`.
  - Map `run.updated`, `message.part.delta`, `run.tool.start`, and `run.tool.result` into `UiStateStore` updates and `UiEvent` publications.
- Create: `packages/ohbaby-agent/src/adapters/ui-runtime/types.ts`
  - Hold small adapter-local types shared by composition and stream projection.

## Task 1: Add Failing Contract Coverage

**Files:**
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`

- [ ] Add a recording run ledger test to prove `submitPrompt()` uses `RunManager`.

```ts
it("uses RunManager ledger and stream status for prompt runs", async () => {
  const runLedger = new RecordingRunLedger(() => 1_700_000_000_000);
  const client = createInProcessUiBackendClient({
    llmClient: createFakeLLMClient([{ textDelta: "Done", finishReason: "stop" }]),
    runLedger,
  });
  const events: UiEvent[] = [];
  client.subscribeEvents((event) => events.push(event));

  await client.submitPrompt("Use the runtime manager");

  expect(runLedger.calls).toEqual([
    "createPending",
    "markRunning",
    "markSucceeded",
  ]);
  expect(events.filter((event) => event.type === "run.updated")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        run: expect.objectContaining({
          id: "run_1",
          status: { kind: "running", runId: "run_1" },
        }),
      }),
      expect.objectContaining({
        run: expect.objectContaining({
          id: "run_1",
          status: { kind: "idle" },
        }),
      }),
    ]),
  );
});
```

- [ ] Add an agent filter test that injects an `AgentManager` whose default primary agent includes only `read`.

```ts
it("filters available tools through AgentManager", async () => {
  const requests: ProviderRequest[] = [];
  const registry = new AgentRegistry({
    builtinAgents: [
      {
        default: true,
        description: "Narrow test agent",
        mode: "primary",
        name: "narrow",
        tools: { include: ["read"] },
      },
    ],
    configLoader: () => ({ agents: {} }),
  });
  const agentManager = new AgentManager({ registry });
  const client = createInProcessUiBackendClient({
    agentManager,
    llmClient: createSequentialFakeLLMClient(
      [[{ textDelta: "Filtered", finishReason: "stop" }]],
      requests,
    ),
  });

  await client.submitPrompt("Which tools are available?");

  expect(requests[0]?.tools?.map((tool) => tool.function.name)).toEqual([
    "read",
  ]);
});
```

- [ ] Run the focused failing tests.

Run: `pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`

Expected before implementation: the new tests fail because `InProcessUiBackendOptions` has no `runLedger`/`agentManager` injection and the adapter still registers bare `BUILTIN_TOOLS` without `agentTools`.

## Task 2: Extract Host-Local Runtime Environment

**Files:**
- Create: `packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`

- [ ] Move `normalizeForBoundary`, `assertInsideWorkdir`, `resolveHostPath`, and `createHostLocalEnvironment` from `ui-inprocess.ts` into the new module.

```ts
export function createHostLocalEnvironment(
  workdir = process.cwd(),
): ToolExecutionEnvironment {
  const root = path.resolve(workdir);
  return {
    workdir: root,
    resolvePath(inputPath: string): string {
      return assertInsideWorkdir(root, inputPath, resolveHostPath(root, inputPath));
    },
    async resolvePathForExisting(inputPath: string): Promise<string> {
      const resolved = await fs.realpath(resolveHostPath(root, inputPath));
      return assertInsideWorkdir(root, inputPath, resolved);
    },
    async resolvePathForWrite(inputPath: string): Promise<string> {
      const target = resolveHostPath(root, inputPath);
      const realParent = await fs.realpath(path.dirname(target));
      return assertInsideWorkdir(root, inputPath, path.join(realParent, path.basename(target)));
    },
    resolveCommandContext(): { readonly cwd: string; readonly kind: string } {
      return { cwd: root, kind: "host-local" };
    },
  };
}
```

- [ ] Add a `createHostLocalSandboxManager(workdir?: string): SandboxManager` export that returns a lease with the same environment methods and releases as a no-op.

- [ ] Replace the local helper imports in `ui-inprocess.ts` with `createHostLocalEnvironment` only where command/tool code still needs it during migration.

## Task 3: Compose the Real Runtime

**Files:**
- Create: `packages/ohbaby-agent/src/adapters/ui-runtime/types.ts`
- Create: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`

- [ ] Extend `InProcessUiBackendOptions` with optional, backward-compatible test seams.

```ts
readonly agentManager?: AgentManager;
readonly runLedger?: RunLedger;
readonly streamBridge?: StreamBridge;
readonly createRunId?: () => string;
readonly workdir?: string;
```

- [ ] In `composition.ts`, initialize `AgentManager` once and pass it to `createToolScheduler({ bus, permission, policy, agentTools: agentManager })`.

- [ ] Build the task executor with `SubagentExecutor`; its runner should create a child run through the same `RunManager`, wait for completion, and read the final assistant text from `messageManager.listBySession(childSessionId)`.

- [ ] Register tools with:

```ts
for (const tool of createBuiltinTools({ taskExecutor })) {
  toolScheduler.register(tool);
}
```

- [ ] Use `createInMemoryRunLedger()` and `createInMemoryStreamBridge({ heartbeatIntervalMs: 0 })` by default, while honoring injected `runLedger` and `streamBridge`.

- [ ] Create `RunManager` with `Lifecycle`, `runLedger`, `streamBridge`, `createHostLocalSandboxManager(options.workdir)`, the default runtime policy, a profile registry returning `{ id }`, and a queued `reserveRunId()` source so `ui-inprocess.ts` can subscribe to `run/<id>` before `RunManager.create()`.

## Task 4: Project Run Streams Into UI State

**Files:**
- Create: `packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`

- [ ] Implement a mapper from `RunRecord` stream data to `UiRun`.

```ts
function toUiRunStatus(record: StreamRunRecord): UiRunStatus {
  if (record.status === "pending" || record.status === "running") {
    return { kind: "running", runId: record.runId };
  }
  if (record.status === "succeeded") {
    return { kind: "idle" };
  }
  return {
    kind: "error",
    message: record.error ?? `Run ${record.status}`,
    recoverable: true,
  };
}
```

- [ ] Consume `streamBridge.subscribe(\`run/${runId}\`, 0)` and handle:
  - `run.updated`: add/update the SDK run, publish `run.updated`, and update app runtime status.
  - `message.part.delta`: append/update assistant text, publish `message.updated` and `message.part.delta`.
  - `run.tool.start`: add a running `tool-call` part.
  - `run.tool.result`: mark the call completed/failed and append a `tool-result` part.

- [ ] Ignore heartbeat sentinels and stop on `END_SENTINEL`.

- [ ] In `submitPrompt()`, after user message creation, call `runtime.reserveRunId()`, start stream consumption, then call `runManager.create({ sessionId, triggerSource: "user", agent, parentMessageId, messages, tools })` and `waitForCompletion(runId)`.

- [ ] Preserve the existing error contract: when completion is not `succeeded`, leave snapshot status as `error` and reject `submitPrompt()` with the run error.

## Task 5: Keep Commands and Permissions Compatible

**Files:**
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`

- [ ] Update `/tools` command catalog to call `runtime.listToolSummaries()` instead of reading `BUILTIN_TOOLS`.

- [ ] Keep permission event subscriptions on the same bus; when permission is requested, use the current active run id from the runtime submission state.

- [ ] Update `abortRun()` so active prompt runs call `runManager.cancel(runId, "run aborted")`; command runs continue to call `commandService.abortCommandRun()`.

## Task 6: Verification And Review

**Files:**
- Modify as needed from Tasks 1-5 only.

- [ ] Run adapter/runtime/agents/task tests.

Run: `pnpm exec vitest run packages/ohbaby-agent/src/adapters packages/ohbaby-agent/src/runtime/run-manager packages/ohbaby-agent/src/agents packages/ohbaby-agent/src/tools/task-tool.unit.test.ts`

Expected: all selected suites pass.

- [ ] Run required repository checks.

Run: `pnpm run lint && pnpm run typecheck && pnpm test`

Expected: lint, typecheck, and full test suite pass.

- [ ] Self-review before commit:
  - Verify `ui-inprocess.ts` no longer calls `new Lifecycle(...).run(...)` inside `submitPrompt()`.
  - Verify `createToolScheduler` receives `agentTools: agentManager`.
  - Verify builtin tools are registered from `createBuiltinTools({ taskExecutor })`, not bare `BUILTIN_TOOLS`.
  - Verify `RunManager` remains the owner of ledger transitions and stream `run.updated` events.
  - Verify no snapshot store or DB UI snapshot adapter was implemented in this window.
  - Verify no changes were made to other windows' `agents/search/snapshot` implementation files beyond necessary AgentManager composition imports/tests.
