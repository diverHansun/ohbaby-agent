# Compact Result And Notice UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make compact success truthful and unambiguous: backend only reports `compacted` when active context decreases, while the TUI shows `Compacting...` during manual compact and `Compacted` without token deltas after success.

**Architecture:** Split summary generation from summary commit so projected active context can be estimated before mutating history. Keep token details in `CompactResult` for tests/debug, but make the TUI result text terse. Treat compact success as command feedback, not a persistent notice; clear ephemeral notices on the next active user message or run.

**Tech Stack:** TypeScript, Vitest, Ink TUI, existing ohbaby-agent context manager and ohbaby-cli TUI store.

---

## File Map

- Modify `packages/ohbaby-agent/src/core/context/context-manager.ts`: introduce summary candidate/projected usage guard, update compact status decisions, reuse safe compact semantics for `compress()`.
- Modify `packages/ohbaby-agent/src/adapters/ui-runtime/prompt-context.ts`: stop returning info notices for successful compact/prune; keep warnings for failed/inflated.
- Modify `packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts`: success compaction events should not emit persistent notices.
- Modify `packages/ohbaby-agent/src/commands/builtin.ts`: use neutral compact action or emit success action only for success states.
- Modify `packages/ohbaby-cli/src/tui/store/events.ts`: terse compact command output, derived compact runtime, clear ephemeral UI notices.
- Modify `packages/ohbaby-cli/src/tui/components/working-spinner.tsx`: prefer `runtime.title` over random working phrase.
- Test `packages/ohbaby-agent/src/core/context/manager.unit.test.ts`.
- Test `packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts`.
- Test `packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts`.
- Test `packages/ohbaby-agent/src/commands/service.unit.test.ts`.
- Test `packages/ohbaby-cli/src/tui/store/events.unit.test.ts`.
- Test `packages/ohbaby-cli/src/tui/components/working-spinner.unit.test.tsx`.

---

### Task 1: Backend Compact Truthfulness

**Files:**
- Modify: `packages/ohbaby-agent/src/core/context/context-manager.ts`
- Test: `packages/ohbaby-agent/src/core/context/manager.unit.test.ts`

- [ ] **Step 1: Add failing tests for unsafe compact statuses**

Add tests that prove:

```typescript
it("does not commit a summary when projected usage is not lower than after-prune usage", async () => {
  const messageManager = createMessageManagerFixture();
  await seedConversationWithLargeRetainedUsageAnchor(messageManager, "session_1");
  const { manager } = createManager({
    llmClient: { generateSummary: vi.fn().mockResolvedValue("short summary") },
    messageManager,
  });

  const result = await manager.compact("session_1", {
    directory: "D:/repo",
    force: true,
    modelId: "test-model",
  });

  expect(result.status).not.toBe("compacted");
  expect(await summaryMessageCount(messageManager, "session_1")).toBe(0);
});

it("returns pruned instead of compacted when pruning helps but summary projection is worse", async () => {
  const messageManager = createMessageManagerFixture();
  await seedPrunableConversation(messageManager, "session_1");
  const { manager } = createManager({
    llmClient: { generateSummary: vi.fn().mockResolvedValue("summary that projects larger than prune-only") },
    messageManager,
  });

  const result = await manager.compact("session_1", {
    directory: "D:/repo",
    force: true,
    modelId: "test-model",
  });

  expect(result.status).toBe("pruned");
  expect(result.usageAfter.currentTokens).toBeLessThan(result.usageBefore.currentTokens);
  expect(await summaryMessageCount(messageManager, "session_1")).toBe(0);
});
```

Use local helpers in `manager.unit.test.ts` named `seedConversationWithLargeRetainedUsageAnchor`, `seedPrunableConversation`, and `summaryMessageCount`. Each helper must append real user/assistant/tool messages through `messageManager`; do not mock `manager.compact()`.

- [ ] **Step 2: Run tests to verify RED**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts --passWithNoTests
```

Expected: new tests fail because `summarizeHistory()` mutates history before projected usage can reject the candidate.

- [ ] **Step 3: Split candidate generation from commit**

In `context-manager.ts`, replace write-inside `summarizeHistory()` with:

```typescript
type SummaryCandidate =
  | CompressionResult
  | {
      readonly status: "candidate";
      readonly historyToCompress: readonly MessageWithParts[];
      readonly newTokens: number;
      readonly originalTokens: number;
      readonly savedTokens: number;
      readonly snapshot: string;
    };

async function generateSummaryCandidate(
  sessionId: string,
  rawHistory: readonly MessageWithParts[],
): Promise<SummaryCandidate> {
  // Select active non-summary history, choose historyToCompress,
  // call generateSummary with the normal then aggressive prompt,
  // append file operation facts to the snapshot, and compare snapshot tokens.
  // This function returns failed/skipped/inflated/candidate and performs no writes.
}

async function commitSummaryCandidate(
  sessionId: string,
  rawHistory: readonly MessageWithParts[],
  candidate: Extract<SummaryCandidate, { readonly status: "candidate" }>,
): Promise<CompressionResult> {
  // Create summary message, compact candidate.historyToCompress parts, clear retained tokenUsage.
}
```

Keep existing `CompressionResult` shape unchanged for SDK compatibility.

- [ ] **Step 4: Add projected context helper**

Add a helper that builds an in-memory projected context:

```typescript
function projectSummaryCandidate(input: {
  readonly assembled: AssembledContext;
  readonly candidate: Extract<SummaryCandidate, { readonly status: "candidate" }>;
  readonly compactedAt: number;
  readonly sessionId: string;
}): AssembledContext {
  // Mark candidate parts compacted in memory.
  // Insert a synthetic assistant summary message with metadata kind context-summary.
  // Remove tokenUsage metadata from retained active parts.
  // Return assembleFromRawHistory with the original system prompt, memory,
  // projected raw history, session id, and a fresh assembledAt timestamp.
}
```

The projection must compare `projectedUsage.currentTokens` against `usageAfterPrune.currentTokens`.

- [ ] **Step 5: Wire `compact()` and `prepareTurn()`**

Update both paths so:

- candidate `failed` returns `failed`;
- candidate `inflated` returns `pruned` if prune helped, otherwise `inflated`;
- candidate projected usage not lower than after-prune baseline returns `pruned` if prune helped, otherwise `inflated`;
- only committed candidate with final usage lower than `usageBefore` returns `compacted`.

- [ ] **Step 6: Keep `compress()` safe**

Make `compress(sessionId, force, modelId)` call `compact(sessionId, { directory: "", force, modelId })` or share the safe helper directly. Map the result back:

```typescript
if (compactResult.status === "compacted" && compactResult.compression) {
  return compactResult.compression;
}
return {
  status: compactResult.status === "failed" ? "failed" : "skipped",
  originalTokens: compactResult.usageBefore.currentTokens,
  newTokens: compactResult.usageAfter.currentTokens,
  savedTokens: Math.max(0, compactResult.usageBefore.currentTokens - compactResult.usageAfter.currentTokens),
  error: compactResult.error,
};
```

- [ ] **Step 7: Run backend context tests to verify GREEN**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts --passWithNoTests
```

Expected: all tests in that file pass.

---

### Task 2: Compact Notices And Command Semantics

**Files:**
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/prompt-context.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts`
- Modify: `packages/ohbaby-agent/src/commands/builtin.ts`
- Test: `packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts`
- Test: `packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts`
- Test: `packages/ohbaby-agent/src/commands/service.unit.test.ts`

- [ ] **Step 1: Add failing tests for no success notice**

Update tests so compact success no longer calls `onNotice`, while failed/inflated still does:

```typescript
expect(onNotice).not.toHaveBeenCalled();
```

Add a direct test for `noticeFromCompactResult()` if there is already a test file; otherwise cover through existing adapter tests.

- [ ] **Step 2: Run adapter tests to verify RED**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts packages/ohbaby-agent/src/commands/service.unit.test.ts --passWithNoTests
```

Expected: tests fail because successful compact currently emits info notices and command action is always `session.compacted`.

- [ ] **Step 3: Stop success notices**

Change `noticeFromCompactResult()` so:

```typescript
if (result.status === "compacted" || result.status === "pruned" || result.status === "not-needed") {
  return undefined;
}
```

Keep warning notices for `failed` and `inflated`, but remove token deltas from their messages.

- [ ] **Step 4: Make command action neutral or success-only**

In `handleSessionCompact()`, either emit `session.compact.completed` for every result or emit `session.compacted` only when `result.status` is `compacted` or `pruned`. Prefer:

```typescript
context.emitAction(action("session.compact.completed", {
  sessionId: result.sessionId,
  status: result.status,
}));
```

Update the command service test to expect `session.compact.completed`.

- [ ] **Step 5: Run adapter and command tests to verify GREEN**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts packages/ohbaby-agent/src/commands/service.unit.test.ts --passWithNoTests
```

Expected: selected tests pass.

---

### Task 3: TUI Compact Output, Spinner, And Notice Cleanup

**Files:**
- Modify: `packages/ohbaby-cli/src/tui/store/events.ts`
- Modify: `packages/ohbaby-cli/src/tui/components/working-spinner.tsx`
- Test: `packages/ohbaby-cli/src/tui/store/events.unit.test.ts`
- Test: `packages/ohbaby-cli/src/tui/components/working-spinner.unit.test.tsx`

- [ ] **Step 1: Add failing TUI tests**

Update and add tests:

```typescript
expect(latestCommandNoticeText(state)).toBe("Compacted");
expect(latestCommandNoticeText(skippedState)).toBe("Compact skipped");
expect(latestCommandNoticeText(failedState)).toBe("Compact failed");
```

Add tests that compact command start sets runtime title:

```typescript
state = applyEvent(state, compactCommandStartedEvent());
expect(state.runtime).toEqual({
  kind: "running",
  runId: "command_compact",
  title: "Compacting...",
});
```

Add tests that the matching result/failed event restores idle and that active user messages clear ephemeral UI notices but keep `prompt-security:*` notices.

Add a `WorkingSpinner` test:

```typescript
expect(frameOf({ kind: "running", runId: "command_compact", title: "Compacting..." })).toContain("Compacting...");
```

- [ ] **Step 2: Run TUI tests to verify RED**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-cli/src/tui/store/events.unit.test.ts packages/ohbaby-cli/src/tui/components/working-spinner.unit.test.tsx --passWithNoTests
```

Expected: new tests fail because compact output still includes token deltas, runtime title is ignored, and UI notices persist.

- [ ] **Step 3: Update command output formatter**

In `formatDataCommandOutput()` for `session.compact`:

```typescript
switch (status) {
  case "compacted":
  case "pruned":
    return "Compacted";
  case "failed":
    return "Compact failed";
  case "inflated":
  case "not-needed":
    return "Compact skipped";
}
```

- [ ] **Step 4: Derive compact runtime in store**

On `command.started` with `command.commandId === "compact"` set:

```typescript
runtime: {
  kind: "running",
  runId: event.command.commandRunId,
  title: "Compacting...",
}
```

On matching `command.result.delivered` or `command.failed`, restore `runtime: { kind: "idle" }` only if current runtime is the same command run id.

- [ ] **Step 5: Clear ephemeral notices**

Add:

```typescript
function isPersistentNotice(notice: UiNotice): boolean {
  return (notice.key ?? notice.id).startsWith("prompt-security:");
}

function clearEphemeralNotices(state: TuiStoreState): TuiStoreState {
  const notices = state.notices.filter(isPersistentNotice);
  return notices.length === state.notices.length ? state : { ...state, notices };
}
```

Call it when the active session appends a user message and when runtime enters running.

- [ ] **Step 6: Prefer runtime title in spinner**

In `WorkingSpinner`, set:

```typescript
const text = runtime.kind === "running" && runtime.title ? runtime.title : phrase;
```

Render `text` in `ShimmerText`.

- [ ] **Step 7: Run TUI tests to verify GREEN**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-cli/src/tui/store/events.unit.test.ts packages/ohbaby-cli/src/tui/components/working-spinner.unit.test.tsx --passWithNoTests
```

Expected: selected tests pass.

---

### Task 4: Final Verification

**Files:** All touched files.

- [ ] **Step 1: Run targeted compact/backend/TUI tests**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts packages/ohbaby-agent/src/commands/service.unit.test.ts packages/ohbaby-cli/src/tui/store/events.unit.test.ts packages/ohbaby-cli/src/tui/components/working-spinner.unit.test.tsx --passWithNoTests
```

- [ ] **Step 2: Run typecheck**

Run:

```powershell
pnpm run typecheck
```

- [ ] **Step 3: Inspect git diff**

Run:

```powershell
git diff --stat
git diff --check
```

- [ ] **Step 4: Commit implementation**

Commit only files changed for this task:

```powershell
git add docs/superpowers/plans/2026-06-09-compact-result-notice-ui.md packages/ohbaby-agent/src/core/context/context-manager.ts packages/ohbaby-agent/src/core/context/manager.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/prompt-context.ts packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts packages/ohbaby-agent/src/commands/builtin.ts packages/ohbaby-agent/src/commands/service.unit.test.ts packages/ohbaby-cli/src/tui/store/events.ts packages/ohbaby-cli/src/tui/store/events.unit.test.ts packages/ohbaby-cli/src/tui/components/working-spinner.tsx packages/ohbaby-cli/src/tui/components/working-spinner.unit.test.tsx
git commit -m "fix(compact): guard compaction and simplify UI feedback"
```
