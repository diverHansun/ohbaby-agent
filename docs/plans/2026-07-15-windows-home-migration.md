# Windows Home Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make unified ohbaby configuration and data migration reliable on Windows while preserving macOS and Linux behavior.

**Architecture:** Retain the existing shared path facade and idempotent migration service. Add native-platform tests and narrow platform-aware corrections, then enforce the supported OS matrix in CI.

**Tech Stack:** TypeScript, Node.js filesystem/path APIs, Vitest, pnpm, GitHub Actions

---

### Task 1: Make migration tests platform-correct

**Files:**
- Modify: `packages/ohbaby-agent/src/migration/ohbaby-home.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/migration/ohbaby-home.ts`

**Step 1:** Add a Windows-native configuration migration test covering global and project roots.

**Step 2:** Run the new test and verify that it fails for the expected path/report or permission reason.

**Step 3:** Make the minimal platform-aware implementation/test correction.

**Step 4:** Run the migration unit test file and verify it passes on Windows.

### Task 2: Cover Windows Roaming-to-Local data migration

**Files:**
- Modify: `packages/ohbaby-agent/src/paths/ohbaby-home.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/migration/ohbaby-home.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/paths/ohbaby-home.ts`

**Step 1:** Add a failing test that migrates the database, WAL, SHM, and storage from `%APPDATA%\ohbaby-agent` to `%LOCALAPPDATA%\ohbaby`.

**Step 2:** Verify the failure is caused by unsupported Windows behavior rather than test setup.

**Step 3:** Implement only the path/migration correction required by the test.

**Step 4:** Run path and migration tests, including Linux and macOS cases.

### Task 3: Remove platform-specific CLI assertion

**Files:**
- Modify: `packages/ohbaby-cli/src/bin.unit.test.ts`

**Step 1:** Express the expected web asset location with Node path APIs.

**Step 2:** Run the CLI unit test and verify the previous Windows failure is gone.

### Task 4: Add multi-OS CI coverage

**Files:**
- Modify: `.github/workflows/ci.yml`

**Step 1:** Add an Ubuntu/Windows/macOS matrix without changing the project test commands.

**Step 2:** Validate workflow syntax and run the equivalent local commands available on Windows.

### Task 5: Verify and migrate the current Windows profile

**Files:**
- Runtime roots: `%USERPROFILE%\.ohbaby-agent`, `%USERPROFILE%\.ohbaby`, project `.ohbaby-agent`, project `.ohbaby`

**Step 1:** Run targeted tests, typecheck, lint, full tests, and build.

**Step 2:** Run the verified migration entry points against the current profile and project.

**Step 3:** Confirm destination inventories and database hashes without printing `.env` values.

**Step 4:** Re-run startup-relevant tests and review the final diff.
