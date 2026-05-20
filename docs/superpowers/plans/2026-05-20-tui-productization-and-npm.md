# TUI Productization And NPM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the next MVP closure slice: npm-oriented installation, `ohbaby` interactive startup, Ink TUI branding/composer polish, slash-command menu, and policy mode visibility/switching.

**Architecture:** Keep the runtime single-process and keep the TUI on Ink. The CLI package `ohbaby-agent` remains the user-facing npm package and exposes the `ohbaby` binary; SDK/TUI packages stay internal workspace packages for development but must be publishable dependencies or bundled in a way `npm install -g ohbaby-agent` works. TUI productization should layer small Ink components over the current store/backend contract instead of replacing the app shell.

**Tech Stack:** TypeScript, pnpm workspace, npm package metadata, Ink 6, React 19, Vitest, ink-testing-library, tsup, fake in-process backend E2E.

---

## Work Packages

### Task 1: NPM Packaging And Packed Smoke

**Files:**
- Modify: `packages/ohbaby-agent/package.json`
- Modify: `packages/ohbaby-tui/package.json`
- Modify: `packages/ohbaby-sdk/package.json`
- Modify: `package.json`
- Modify/Create tests under `tests/integration/cli/`
- Create: `docs/implementation/tui-productization/npm-packaging.md`

**Steps:**
- [x] Document the packaging decision: development stays pnpm workspace; user install is `npm install -g ohbaby-agent`; binary is `ohbaby`.
- [x] Add a failing smoke test that packs the package graph, installs it into a temp prefix, and verifies `ohbaby --help` and `ohbaby --version`.
- [x] Make workspace package metadata publish-ready without changing runtime behavior: remove package-level `private: true` where needed, add `publishConfig`, ensure `files` include built artifacts and required package metadata.
- [x] Replace or prepare `workspace:*` dependencies for publish artifacts so a packed `ohbaby-agent` can resolve `ohbaby-sdk` and `ohbaby-tui`.
- [x] Run the packed smoke test and then `pnpm build`.

### Task 2: Ink Branding, Header, Footer, And Prompt Label

**Files:**
- Modify: `packages/ohbaby-tui/src/app.tsx`
- Modify: `packages/ohbaby-tui/src/components/message/message-list.tsx`
- Modify: `packages/ohbaby-tui/src/components/prompt/index.tsx`
- Modify: `packages/ohbaby-tui/src/components/status-bar.tsx`
- Create: `packages/ohbaby-tui/src/components/logo.tsx`
- Create: `packages/ohbaby-tui/src/components/header.tsx`
- Create: `packages/ohbaby-tui/src/components/footer.tsx`
- Modify: `packages/ohbaby-tui/src/app.contract.test.tsx`
- Modify: `tests/integration/tui/main-chain.integration.test.tsx`
- Create: `docs/implementation/tui-productization/tui-branding.md`

**Steps:**
- [x] Document the Ink layout: logo/header only for empty first screen; message transcript first when a session is restored; footer always shows concise status.
- [x] Add failing tests that expect `ohbaby` as assistant label and `ohbaby >` as the input prompt.
- [x] Add a small ASCII `Logo` component with ASCII-only text.
- [x] Add `Header` and `Footer` components that show brand, current runtime status, active session, and command hint text without replacing the existing status contract.
- [x] Update snapshots/tests so existing prompt submit, streaming, permission, and abort behavior still pass.

### Task 3: Slash Command Menu Upgrade

**Files:**
- Modify: `packages/ohbaby-tui/src/components/prompt/index.tsx`
- Modify: `packages/ohbaby-tui/src/components/prompt/completion.tsx`
- Modify: `packages/ohbaby-tui/src/command/completions.ts`
- Modify: `packages/ohbaby-tui/src/command/runtime.ts`
- Modify: `packages/ohbaby-tui/src/command/runtime.unit.test.ts`
- Modify: `packages/ohbaby-tui/src/app.contract.test.tsx`
- Create: `docs/implementation/tui-productization/slash-menu.md`

**Steps:**
- [x] Document the MVP slash menu: `/` opens candidates, up/down changes selection, Enter executes selected command when no arguments are being typed, Tab completes when unambiguous.
- [x] Add failing tests for slash candidate selection, Tab completion, and exact command execution.
- [x] Keep the current backend command catalog as the source of truth.
- [x] Render at most six command candidates with command path and description.
- [x] Preserve command catalog failure visibility.

### Task 4: Policy Mode Surface And Switching

**Files:**
- Modify: `packages/ohbaby-sdk/src/snapshot.ts`
- Modify: `packages/ohbaby-sdk/src/events.ts`
- Modify: `packages/ohbaby-sdk/src/events.contract.test.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`
- Modify: `packages/ohbaby-agent/src/commands/catalog.ts`
- Modify: `packages/ohbaby-agent/src/commands/builtin.ts`
- Modify: `packages/ohbaby-agent/src/commands/types.ts`
- Modify: `packages/ohbaby-agent/src/commands/service.unit.test.ts`
- Modify: `packages/ohbaby-tui/src/store/events.ts`
- Modify: `packages/ohbaby-tui/src/store/snapshot.ts`
- Modify: `packages/ohbaby-tui/src/store/events.unit.test.ts`
- Modify: `packages/ohbaby-tui/src/app.tsx`
- Modify: `packages/ohbaby-tui/src/components/status-bar.tsx`
- Modify: `packages/ohbaby-tui/src/app.contract.test.tsx`
- Create: `docs/implementation/tui-productization/policy-mode.md`

**Steps:**
- [x] Document current policy semantics: `agent`, `ask`, `plan`, plus `ask-before-edit` and `edit-automatically`.
- [x] Add failing SDK/store/backend tests for snapshot policy state and `policy.updated`.
- [x] Expose policy state from in-process backend snapshots.
- [x] Publish `policy.updated` when mode or agent-state changes.
- [x] Add `/mode`, `/mode ask`, `/mode plan`, `/mode agent`, and `/mode auto-edit` command handling.
- [x] Add a TUI keybinding for mode cycling after verifying Ink event behavior; prefer Shift+Tab, use a fallback if tests show it is unreliable.
- [x] Show policy mode in the status/footer without blocking prompt submission.

### Task 5: Integration Verification And Review

**Files:**
- Modify integration tests under `tests/integration/tui/`
- Modify integration tests under `tests/integration/cli/`
- Create: `docs/implementation/tui-productization/verification.md`

**Steps:**
- [x] Add/adjust fake E2E coverage for branded prompt, slash menu execution, policy mode switching, and recovery after abort.
- [x] Add packed npm smoke verification.
- [x] Run targeted tests for changed areas.
- [x] Run full verification: `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm build`.
- [x] Run a subagent review focused on UX regressions, publish risk, and command/policy contract drift.

## Notes From References

- opencode: strong first impression from logo plus command map; rich command registry; keybind provider; prompt composer shows model/agent metadata near the input.
- Claude Code: Ink lineage, explicit permission modes, plan/auto mode safety copy, careful input handling around paste and command parsing.
- DeepSeek-TUI: clear header/footer chips, mode picker, slash menu helper separation, QA harness discipline.

## Non-Goals

- Do not implement attachable server, HTTP SDK, MCP, plugin, or skill surfaces in this round.
- Do not migrate from Ink to OpenTUI.
- Do not add full multi-line editor, file mention, shell mode, theme picker, or mouse support yet.
- Do not depend on real provider/API keys in automated tests.
