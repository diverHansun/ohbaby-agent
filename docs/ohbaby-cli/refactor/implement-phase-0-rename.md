# Phase 0 Rename Implementation Plan

> **For agentic workers:** Execute this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Rename `ohbaby-tui` to `ohbaby-cli`, move the Ink renderer under `src/tui/`, and update all code, tests, package metadata, and documentation references without changing runtime behavior.

**Architecture:** `ohbaby-agent/src/bin.ts` remains the CLI composition root and dynamic-imports the frontend package. `ohbaby-cli/src/index.ts` is a thin public entry that re-exports `./tui/index.js`. TUI internals remain behaviorally unchanged in Phase 0.

**Tech Stack:** pnpm workspace, TypeScript project references, tsup, Vitest, Ink/React.

---

## Source Of Truth

The complete migration checklist is [rename-tui-to-cli.md §4](rename-tui-to-cli.md). This implementation plan orders that checklist into verifiable tasks.

---

## Task 1: Update Package Directory And Entry Shape

**Files:**

- Move: `packages/ohbaby-tui/` -> `packages/ohbaby-cli/`
- Move: `packages/ohbaby-cli/src/*` -> `packages/ohbaby-cli/src/tui/*`
- Create: `packages/ohbaby-cli/src/index.ts`
- Modify: `packages/ohbaby-cli/package.json`
- Modify: `packages/ohbaby-cli/tsup.config.ts`

- [x] Move the package directory with `git mv packages/ohbaby-tui packages/ohbaby-cli`.
- [x] Create `packages/ohbaby-cli/src/tui/` and move the existing TUI source files into it.
- [x] Create `packages/ohbaby-cli/src/index.ts` with `export * from "./tui/index.js";`.
- [x] Change package metadata name to `ohbaby-cli` and update description to describe the CLI frontend.
- [x] Change tsup entry from `src/index.tsx` to `src/index.ts`.
- [x] Delete `packages/ohbaby-cli/tsconfig.tsbuildinfo` if present so TypeScript rebuilds with new paths.

**Verify:**

- `Test-Path packages/ohbaby-cli/src/tui/index.tsx` returns true.
- `Test-Path packages/ohbaby-tui` returns false.

---

## Task 2: Update Workspace And Backend References

**Files:**

- Modify: `tsconfig.base.json`
- Modify: `tsconfig.json`
- Modify: `packages/ohbaby-agent/package.json`
- Modify: `packages/ohbaby-agent/tsconfig.json`
- Modify: `packages/ohbaby-agent/tsup.config.ts`
- Modify: `packages/ohbaby-agent/src/bin.ts`

- [x] Replace the `ohbaby-tui` path alias with `ohbaby-cli`.
- [x] Replace root project reference `./packages/ohbaby-tui` with `./packages/ohbaby-cli`.
- [x] Replace `packages/ohbaby-agent` dependency `ohbaby-tui` with `ohbaby-cli`.
- [x] Replace `packages/ohbaby-agent` project reference `../ohbaby-tui` with `../ohbaby-cli`.
- [x] Replace tsup external `ohbaby-tui` with `ohbaby-cli`.
- [x] Replace dynamic import string `await import("ohbaby-tui")` with `await import("ohbaby-cli")`.

**Verify:**

- `rg -n -F "ohbaby-tui" packages tsconfig.base.json tsconfig.json vitest.config.ts` only reports deliberate historical docs if any; source/config should be clean.

---

## Task 3: Update Tests And Packaging Smoke

**Files:**

- Modify: `vitest.config.ts`
- Modify: `tests/integration/tui/main-chain.integration.test.tsx`
- Modify: `tests/integration/tui/persistent-display.integration.test.tsx`
- Modify: `tests/smoke/tui-real-provider.smoke.test.tsx`
- Modify: `tests/integration/cli/packaging-smoke.integration.test.ts`

- [x] Update React test aliases from `packages/ohbaby-tui/node_modules/react/...` to `packages/ohbaby-cli/node_modules/react/...`.
- [x] Update test alias `find: "ohbaby-tui"` to `find: "ohbaby-cli"` and point to `packages/ohbaby-cli/src/index.ts`.
- [x] Update test imports from `"ohbaby-tui"` to `"ohbaby-cli"`.
- [x] Update direct internal test import paths from `packages/ohbaby-tui/src/...` to `packages/ohbaby-cli/src/tui/...`.
- [x] Update packaging smoke build filters, package directory, local tarball name expectations, and install inputs to use `ohbaby-cli`.
- [x] Keep temporary workspace prefixes that contain `ohbaby-tui` only if they are historical test labels; prefer updating them to `ohbaby-cli` for clarity.

**Verify:**

- `pnpm vitest run tests/integration/cli/packaging-smoke.integration.test.ts --runInBand`
- `pnpm vitest run tests/integration/tui/main-chain.integration.test.tsx --runInBand`

---

## Task 4: Update Documentation References

**Files:**

- Modify: `README.md`
- Modify: `package.json`
- Modify: `packages/ohbaby-cli/README.md`
- Modify: `packages/ohbaby-agent/README.md`
- Modify: `packages/ohbaby-sdk/README.md`
- Modify: `docs/cli/**`
- Modify: `docs/ohbaby-sdk/**`
- Modify: `docs/ui/**`
- Modify: `docs/implementation/tui-productization/**`
- Modify: `docs/plugins/**`
- Modify: `docs/problem-lists/**` where references are active, not historical

- [x] Replace active package references with `ohbaby-cli`.
- [x] Update active paths from `packages/ohbaby-tui/` to `packages/ohbaby-cli/src/tui/` where they describe TUI source.
- [x] In historical planning docs, either keep old names as history or add a one-line note that `ohbaby-tui` was renamed to `ohbaby-cli`.
- [x] Add a clarification to `docs/cli/architecture.md` that `docs/cli/` describes `ohbaby-agent/src/bin.ts` as composition root, while `packages/ohbaby-cli/` is the CLI frontend package.

**Verify:**

- `rg -n -F "ohbaby-tui" README.md package.json packages docs tests` returns only historical references or the rename docs themselves.

---

## Task 5: Refresh Lockfile And Full Verification

**Files:**

- Modify: `pnpm-lock.yaml`

- [x] Run `pnpm install`.
- [x] Run `pnpm run typecheck`.
- [x] Run `pnpm run test`.
- [x] Run `pnpm run build`.
- [x] Run `rg -n -F "ohbaby-tui" packages tests tsconfig.base.json tsconfig.json vitest.config.ts package.json README.md` and confirm no active source/config references remain.

**Acceptance:**

- Typecheck exits 0.
- Test exits 0.
- Build exits 0.
- `ohbaby-cli` is the only frontend package name in active code/config.
- Public exports remain `renderTerminalUi`, `OhbabyTerminalApp`, and `TerminalUiOptions`.
