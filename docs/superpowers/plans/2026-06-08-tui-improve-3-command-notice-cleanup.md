# TUI Improve 3 Command Notice Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear stale TUI command notices before the next active-session prompt or run output so old `/status`, slash cancel, or command errors cannot appear under later assistant output.

**Architecture:** Keep `commandNotices` as a short-lived TUI-local queue in `events.ts`. Add a small reducer helper that clears only `state.commandNotices`, preserving global `notices`, transcript messages, interactions, permissions, and command session ownership.

**Tech Stack:** TypeScript, Vitest, existing `packages/ohbaby-cli/src/tui/store/events.ts` reducer.

---

### Task 1: Add failing reducer tests

**Files:**

- Modify: `packages/ohbaby-cli/src/tui/store/events.unit.test.ts`

- [x] **Step 1: Add tests for user prompt cleanup**

Add tests near the existing command notice tests:

```ts
  it("clears command notices when the active session appends a user message", () => {
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      output: { kind: "text", text: "status output" },
      timestamp: 1,
      type: "command.result.delivered",
    });

    state = applyTuiEvent(state, {
      message: userMessage("user_2", "next prompt"),
      sessionId: "session_1",
      type: "message.appended",
    });

    expect(state.commandNotices).toHaveLength(0);
  });
```

- [x] **Step 2: Add tests for command error cleanup**

```ts
  it("clears command error notices when the active session appends a user message", () => {
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      error: { code: "USER_CANCELLED", message: "Session selection cancelled" },
      timestamp: 1,
      type: "command.failed",
    });

    state = applyTuiEvent(state, {
      message: userMessage("user_2", "next prompt"),
      sessionId: "session_1",
      type: "message.appended",
    });

    expect(state.commandNotices).toHaveLength(0);
  });
```

- [x] **Step 3: Add tests for run start cleanup**

```ts
  it("clears command notices when the active session run starts", () => {
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      output: { kind: "text", text: "status output" },
      timestamp: 1,
      type: "command.result.delivered",
    });

    state = applyTuiEvent(state, {
      run: {
        id: "run_1",
        sessionId: "session_1",
        startedAt: "2026-05-14T00:00:03.000Z",
        status: { kind: "running", runId: "run_1" },
        updatedAt: "2026-05-14T00:00:03.000Z",
      },
      type: "run.updated",
    });

    expect(state.commandNotices).toHaveLength(0);
  });
```

- [x] **Step 4: Add test that non-active session appends do not clear active notices**

```ts
  it("does not clear command notices for a non-active session message append", () => {
    let state = applyTuiEvent(createStateFromSnapshot(snapshot()), {
      clientInvocationId: "invoke_1",
      commandRunId: "command_1",
      output: { kind: "text", text: "status output" },
      timestamp: 1,
      type: "command.result.delivered",
    });

    state = applyTuiEvent(state, {
      message: userMessage("user_2", "other prompt"),
      sessionId: "session_2",
      type: "message.appended",
    });

    expect(state.commandNotices).toHaveLength(1);
  });
```

- [x] **Step 5: Run tests and verify RED**

Run:

```powershell
pnpm test -- packages/ohbaby-cli/src/tui/store/events.unit.test.ts
```

Expected: the new cleanup tests fail because `state.commandNotices` is still preserved.

### Task 2: Implement reducer cleanup

**Files:**

- Modify: `packages/ohbaby-cli/src/tui/store/events.ts`

- [x] **Step 1: Add helper**

Add near `appendCommandNotice`:

```ts
function clearCommandNotices(state: TuiStoreState): TuiStoreState {
  if (state.commandNotices.length === 0) {
    return state;
  }

  return {
    ...state,
    commandNotices: [],
  };
}
```

- [x] **Step 2: Clear when active user message is appended**

In the `message.appended` case, rebuild first, then clear if the appended message belongs to active session and `event.message.role === "user"`.

- [x] **Step 3: Clear when active run enters running**

In the `run.updated` case, rebuild first, then clear if `event.run.sessionId === state.activeSessionId` and `event.run.status.kind === "running"`.

- [x] **Step 4: Clear when runtime directly enters running**

In the `runtime.updated` case, rebuild first, then clear if `event.status.kind === "running"`.

- [x] **Step 5: Run focused tests**

Run:

```powershell
pnpm test -- packages/ohbaby-cli/src/tui/store/events.unit.test.ts
```

Expected: all focused reducer tests pass.

### Task 3: Verify and review

**Files:**

- No source changes unless tests reveal a gap.

- [x] **Step 1: Run package checks**

Run:

```powershell
pnpm typecheck
pnpm test -- packages/ohbaby-cli/src/tui/store/events.unit.test.ts
pnpm test -- packages/ohbaby-cli/src/tui/components/transcript/transcript-viewport.unit.test.tsx
```

Expected: commands pass.

- [x] **Step 2: Inspect diff**

Run:

```powershell
git diff -- packages/ohbaby-cli/src/tui/store/events.ts packages/ohbaby-cli/src/tui/store/events.unit.test.ts
```

Expected: only targeted reducer and tests changed.

- [x] **Step 3: Dispatch code review subagent**

Ask the reviewer to check:

- Whether command notices are cleared only at the intended lifecycle points.
- Whether global `notices`, transcript messages, and command session ownership are preserved.
- Whether tests cover result notice, error notice, active session, and non-active session boundaries.
