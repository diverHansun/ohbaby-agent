# Sessions UI Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the confirmed `/sessions` UI/backend improvements: card-style session picker, current-project active session listing, silent ESC cancellation, and first-message session auto-title behavior.

**Architecture:** Keep the existing interaction broker path and specialize only `SessionDialog` for session selection. Backend session browsing becomes a current-project metadata query keyed by canonical `projectRoot`, while prompt submission owns temporary-title and asynchronous AI-title orchestration because it has access to the active model, project root, and first user message. Snapshot restore limits stay unchanged.

**Tech Stack:** TypeScript, pnpm, Vitest, Ink/React TUI, ohbaby-agent session services, ohbaby-sdk interaction types.

---

## File Structure

- Modify `packages/ohbaby-agent/src/commands/types.ts`: add `createdAt` and `updatedAt` to `CommandSessionSummary`.
- Modify `packages/ohbaby-agent/src/commands/builtin.ts`: include session timestamps in interaction metadata and make `/sessions` cancellation silent.
- Modify `packages/ohbaby-agent/src/services/session/types.ts`, `store.ts`, `database-store.ts`, and `manager.ts`: expose project-root session listing so `/sessions` is not tied only to a mutable Git-derived `project_id`.
- Modify `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`: list current-project active primary sessions by canonical `projectRoot`, detect first user message, write temporary titles, and schedule AI title generation.
- Create `packages/ohbaby-agent/src/services/session/prompt-sanitizer.ts`: sanitize and normalize first-prompt text for titles.
- Create `packages/ohbaby-agent/src/services/session/title-generator.ts`: generate and clean AI titles with the active model.
- Modify `packages/ohbaby-agent/src/services/session/index.ts`: export new title helpers where needed.
- Modify `packages/ohbaby-cli/src/tui/store/snapshot.ts`: preserve interaction option metadata.
- Modify `packages/ohbaby-cli/src/tui/dialogs/session-dialog.tsx`: replace `SelectOneDialog` wrapper with `OverlayCard` session picker.
- Modify `packages/ohbaby-cli/src/tui/app.contract.test.tsx`: assert card UI, metadata time display, PgUp/PgDn, and ESC behavior.
- Modify `packages/ohbaby-agent/src/commands/service.unit.test.ts`: assert silent cancellation and metadata on session choices.
- Modify `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`: assert current-project full active listing and first-message title flow.
- Add unit tests near new helpers:
  - `packages/ohbaby-agent/src/services/session/prompt-sanitizer.unit.test.ts`
  - `packages/ohbaby-agent/src/services/session/title-generator.unit.test.ts`

---

### Task 1: Backend `/sessions` Cancellation And Metadata

**Files:**
- Modify: `packages/ohbaby-agent/src/commands/types.ts`
- Modify: `packages/ohbaby-agent/src/commands/builtin.ts`
- Test: `packages/ohbaby-agent/src/commands/service.unit.test.ts`

- [ ] **Step 1: Write failing tests for timestamp metadata and silent cancellation**

Add/adjust tests so `/sessions` request options contain `metadata.createdAt` and `metadata.updatedAt`, and cancelled interactions do not emit a failed event.

- [ ] **Step 2: Run red tests**

Run: `pnpm vitest run packages/ohbaby-agent/src/commands/service.unit.test.ts --passWithNoTests`

Expected: metadata assertion fails and cancellation still reports `INTERACTION_CANCELLED`.

- [ ] **Step 3: Implement command summary timestamp metadata and silent cancel**

Add optional timestamps to `CommandSessionSummary`. Map them to `UiInteractionOption.metadata` in `handleSessionParent()`. Change cancelled `/sessions` response to `return` without `context.fail()` or action.

- [ ] **Step 4: Run green tests**

Run: `pnpm vitest run packages/ohbaby-agent/src/commands/service.unit.test.ts --passWithNoTests`

Expected: tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ohbaby-agent/src/commands/types.ts packages/ohbaby-agent/src/commands/builtin.ts packages/ohbaby-agent/src/commands/service.unit.test.ts
git commit -m "fix(sessions): make picker cancellation silent"
```

---

### Task 2: Current-Project Session Listing

**Files:**
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
- Test: `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`

- [ ] **Step 1: Write failing tests for project filtering and full active listing**

Add a contract test where injected persistent sessions include more than 50 current-project active primary sessions, an archived session, a subagent, and another-project session. Executing `/sessions` should request an interaction containing only current-project active primary sessions, sorted by `updatedAt DESC`.

- [ ] **Step 2: Run red tests**

Run: `pnpm vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts --passWithNoTests`

Expected: current code uses global `getRecent()` and does not pass the current-project/full-list assertions.

- [ ] **Step 3: Implement project-root session provider path**

Extend the session store and manager with `listByProjectRoot(projectRoot, { status: "active" })`. In `listSessionsFromState()`, resolve the current project root, call `listByProjectRoot(projectRoot, { status: "active" })`, filter `!isSubagent`, sort by `updatedAt DESC, createdAt DESC`, and return timestamps. This preserves the confirmed "current project" behavior even when the same `projectRoot` has historical sessions under older Git-derived `project_id` values.

- [ ] **Step 4: Run green tests**

Run: `pnpm vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts --passWithNoTests`

Expected: project filtering and full active list tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ohbaby-agent/src/adapters/ui-inprocess.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
git commit -m "feat(sessions): list current project sessions"
```

---

### Task 3: SessionDialog Card UI

**Files:**
- Modify: `packages/ohbaby-cli/src/tui/store/snapshot.ts`
- Modify: `packages/ohbaby-cli/src/tui/dialogs/session-dialog.tsx`
- Test: `packages/ohbaby-cli/src/tui/app.contract.test.tsx`

- [ ] **Step 1: Write failing TUI contract tests**

Add tests that emit a session interaction with `metadata.updatedAt`, assert the frame contains `Sessions`, `esc`, title text, formatted `MM-DD HH:mm`, and `showing 1-10 of 12 · pgup/pgdn · ↑↓`. Add a PgUp/PgDn selection test expecting Enter after PgDn to choose `session_11` when 12 sessions are present.

- [ ] **Step 2: Run red tests**

Run: `pnpm vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx --passWithNoTests`

Expected: current `SessionDialog` renders the old naked list and lacks formatted timestamps/footer.

- [ ] **Step 3: Implement card-style SessionDialog**

Preserve `TuiInteractionOption.metadata`. Rewrite `SessionDialog` to use `OverlayCard`, render 10 visible rows, clamp movement, PgUp/PgDn jumps of 10, Enter accepted response, ESC cancelled response, and left-title/right-time layout with truncation.

- [ ] **Step 4: Run green tests**

Run: `pnpm vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx --passWithNoTests`

Expected: session UI tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ohbaby-cli/src/tui/store/snapshot.ts packages/ohbaby-cli/src/tui/dialogs/session-dialog.tsx packages/ohbaby-cli/src/tui/app.contract.test.tsx
git commit -m "feat(tui): render sessions picker as card"
```

---

### Task 4: Prompt Sanitizer And AI Title Generator

**Files:**
- Create: `packages/ohbaby-agent/src/services/session/prompt-sanitizer.ts`
- Create: `packages/ohbaby-agent/src/services/session/title-generator.ts`
- Modify: `packages/ohbaby-agent/src/services/session/index.ts`
- Test: `packages/ohbaby-agent/src/services/session/prompt-sanitizer.unit.test.ts`
- Test: `packages/ohbaby-agent/src/services/session/title-generator.unit.test.ts`

- [ ] **Step 1: Write failing unit tests for sanitizing, temporary titles, and title cleanup**

Tests should cover private key redaction, bearer token redaction, secret/password redaction, `sk-...` redaction, long random token redaction, whitespace normalization, temporary title fallback, `<think>` removal, JSON title extraction, quote removal, markdown fence cleanup, and overlong title truncation.

- [ ] **Step 2: Run red helper tests**

Run: `pnpm vitest run packages/ohbaby-agent/src/services/session/prompt-sanitizer.unit.test.ts packages/ohbaby-agent/src/services/session/title-generator.unit.test.ts --passWithNoTests`

Expected: files/functions do not exist yet.

- [ ] **Step 3: Implement helpers**

Implement sanitizer, `createTemporarySessionTitle()`, `isDefaultSessionTitle()`, `cleanGeneratedTitle()`, and `generateSessionTitle()` using `streamChatCompletion()` with a copied client config `{ maxTokens: 512, temperature: 0.2 }` plus a 5-second AbortController timeout.

- [ ] **Step 4: Run green helper tests**

Run: `pnpm vitest run packages/ohbaby-agent/src/services/session/prompt-sanitizer.unit.test.ts packages/ohbaby-agent/src/services/session/title-generator.unit.test.ts --passWithNoTests`

Expected: helper tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ohbaby-agent/src/services/session/prompt-sanitizer.ts packages/ohbaby-agent/src/services/session/title-generator.ts packages/ohbaby-agent/src/services/session/prompt-sanitizer.unit.test.ts packages/ohbaby-agent/src/services/session/title-generator.unit.test.ts packages/ohbaby-agent/src/services/session/index.ts
git commit -m "feat(sessions): add title generation helpers"
```

---

### Task 5: First-Message Title Orchestration

**Files:**
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
- Test: `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`

- [ ] **Step 1: Write failing integration tests for first-message naming**

Add tests for direct first prompt and `/new` then first prompt. Assert temporary sanitized title is written promptly, AI title updates asynchronously, AI failure keeps temporary title, and title changes before AI completion are not overwritten.

- [ ] **Step 2: Run red tests**

Run: `pnpm vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts --passWithNoTests`

Expected: first-message AI title tests fail because orchestration does not exist.

- [ ] **Step 3: Implement orchestration**

After resolving/creating the session and before the run proceeds, detect first user message conditions. Write temporary title through `sessionManager.update()` when available and update UI state. Schedule an unawaited background task that resolves the active LLM client, generates the AI title, rechecks the session, and updates only if not overwritten.

- [ ] **Step 4: Run green integration tests**

Run: `pnpm vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts --passWithNoTests`

Expected: first-message naming tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ohbaby-agent/src/adapters/ui-inprocess.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
git commit -m "feat(sessions): auto-name first prompt sessions"
```

---

### Task 6: Verification And Review

**Files:**
- Modify only files touched by Tasks 1-5 if verification or review finds a defect.
- Do not modify unrelated files or untracked directories outside this feature.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/commands/service.unit.test.ts --passWithNoTests
pnpm vitest run packages/ohbaby-agent/src/services/session/prompt-sanitizer.unit.test.ts packages/ohbaby-agent/src/services/session/title-generator.unit.test.ts --passWithNoTests
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts --passWithNoTests
pnpm vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx --passWithNoTests
```

Expected: all focused tests pass.

- [ ] **Step 2: Run broader verification**

Run:

```bash
pnpm run typecheck
pnpm run test:unit
pnpm run test:integration
pnpm run test:contract
pnpm run test:e2e:snapshot
pnpm run test:smoke:real
```

Expected: all pass. If real API-key smoke lacks credentials, record the exact skip/failure and continue with available verification.

- [ ] **Step 3: Run subagent review**

Dispatch a review subagent focused on correctness, race conditions, UI regressions, and missing tests. Address actionable findings with tests first.

- [ ] **Step 4: Commit docs and review fixes**

```bash
git add docs/problem-lists/sessions-ui-backend packages/ohbaby-agent packages/ohbaby-cli
git commit -m "docs(sessions): record confirmed implementation plan"
```

Only include files relevant to this feature. Do not include unrelated untracked directories such as `pi/`, `tests/e2e/`, or compact docs.
