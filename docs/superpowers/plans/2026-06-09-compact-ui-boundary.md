# Compact UI Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist compact events in the transcript as `Context compacted` while hiding the full context summary from the TUI.

**Architecture:** Keep core compact summary messages unchanged for LLM context. Add an adapter-only projection in `persistent-store.ts` that maps active context-summary messages to a short UI boundary and drops compacted parts from UI snapshots. This keeps SDK types stable and avoids leaking summary text on session reload.

**Tech Stack:** TypeScript, Vitest, existing ohbaby-agent persistent UI state store.

---

## File Map

- Modify `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts`: detect active context-summary messages, render them as `Context compacted`, and omit compacted parts from normal UI messages.
- Modify `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.integration.test.ts`: add persistent snapshot regressions for summary hiding and compacted part filtering.

---

### Task 1: Persistent Summary Projection

**Files:**
- Modify: `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts`
- Test: `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.integration.test.ts`

- [ ] **Step 1: Write failing tests**

Add a test that creates a context summary message with `agent: "context"` and `metadata.kind: "context-summary"`, then asserts `readSnapshot()` returns a single text part `Context compacted` and does not include the raw summary text.

Add a test that creates a compacted normal text part and an active recent text part, then asserts the compacted text is omitted from the UI snapshot while the active text remains.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-state/persistent-store.integration.test.ts --passWithNoTests
```

Expected: the new tests fail because the raw summary text and compacted parts are still projected into the UI snapshot.

- [ ] **Step 3: Implement minimal projection**

In `messageToUiMessage()`, compute active parts with `isActivePart`. If the message is an active context summary, return:

```typescript
{
  createdAt: toIsoString(message.info.time.created),
  id: message.info.id,
  parts: [{ text: "Context compacted", type: "text" }],
  role: "assistant",
}
```

For non-summary messages, project only active parts and return `undefined` when no UI parts remain. Update `sessionToUiSession()` to filter `undefined` messages.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-state/persistent-store.integration.test.ts --passWithNoTests
```

Expected: all tests in the file pass.

- [ ] **Step 5: Run broader checks**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-state/persistent-store.integration.test.ts packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts packages/ohbaby-cli/src/tui/store/events.unit.test.ts --passWithNoTests
pnpm run typecheck
pnpm run lint
git diff --check
```

Expected: test and typecheck commands pass; lint has no errors; `git diff --check` has no whitespace errors apart from Windows LF/CRLF warnings.
