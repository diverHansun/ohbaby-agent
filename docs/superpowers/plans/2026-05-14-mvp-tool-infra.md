# MVP Tool Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone `project`, `utils`, `sandbox(host-local)`, `shell`, and MVP `command-parser` modules with focused tests, without wiring them into session/memory/run-manager/daemon yet.

**Architecture:** Keep these modules as bottom-layer infrastructure. `project` resolves stable project identity, `sandbox` owns session workdir context and lease safety, `shell` owns shell detection/process cleanup, and `utils` provides shared path/error/text/parser helpers. Public exports are available, but runtime integration is deferred.

**Tech Stack:** TypeScript ESM, Node.js standard library, Vitest, pnpm workspace scripts.

---

### Task 1: Project Module

**Files:**
- Create: `packages/ohbaby-agent/src/project/index.ts`
- Create: `packages/ohbaby-agent/src/project/types.ts`
- Create: `packages/ohbaby-agent/src/project/project-manager.ts`
- Create: `packages/ohbaby-agent/src/project/project-identifier.ts`
- Create: `packages/ohbaby-agent/src/project/project.integration.test.ts`

- [ ] **Step 1: Write failing project integration tests**

Cover these behaviors with real temp directories and real git:
- Non-git directory returns `{ id: "global", rootPath: absoluteDir }`.
- Git root and child directory return the same stable root commit id and root path.
- Empty git repository gracefully falls back to global.
- Missing directory gracefully falls back to global.
- `.git` as file or directory is accepted as a project boundary when present.

Run: `pnpm vitest run packages/ohbaby-agent/src/project/project.integration.test.ts`
Expected: FAIL because `src/project` does not exist.

- [ ] **Step 2: Implement minimal project resolver**

Implement `Project.fromDirectory()`, `Project.getProjectRoot()`, and `Project.isGitProject()`. Use `execFile("git", ["rev-list", "--max-parents=0", "--all"], { cwd })` with timeout instead of shell string execution.

- [ ] **Step 3: Verify project tests and commit**

Run:
- `pnpm vitest run packages/ohbaby-agent/src/project/project.integration.test.ts`
- `pnpm run typecheck`

Commit message: `feat(project): add project resolver`

### Task 2: Utils Foundations

**Files:**
- Create: `packages/ohbaby-agent/src/utils/index.ts`
- Create: `packages/ohbaby-agent/src/utils/error.ts`
- Create: `packages/ohbaby-agent/src/utils/paths.ts`
- Create: `packages/ohbaby-agent/src/utils/lazy.ts`
- Create: `packages/ohbaby-agent/src/utils/format.ts`
- Create: `packages/ohbaby-agent/src/utils/truncate.ts`
- Create: `packages/ohbaby-agent/src/utils/utils.unit.test.ts`

- [ ] **Step 1: Write failing utils unit tests**

Cover:
- `IrisError` code/data serialization and `formatError()`.
- `normalizePath()`, `contains()`, `containsOrEqual()`, `overlaps()`.
- `lazy()` and `lazyAsync()` only initialize once.
- `formatWithLineNumbers()` and `checkEmptyContent()`.
- `truncateIfTooLong()` for string and array inputs.

Run: `pnpm vitest run packages/ohbaby-agent/src/utils/utils.unit.test.ts`
Expected: FAIL because `src/utils` does not exist.

- [ ] **Step 2: Implement minimal utils**

Use Node standard library only. Keep path helpers cross-platform and make equality behavior explicit: `contains()` excludes equal paths, `containsOrEqual()` includes equal paths for sandbox boundary checks.

- [ ] **Step 3: Verify utils tests and commit**

Run:
- `pnpm vitest run packages/ohbaby-agent/src/utils/utils.unit.test.ts`
- `pnpm run typecheck`

Commit message: `feat(utils): add infrastructure helpers`

### Task 3: Sandbox Host-Local

**Files:**
- Create: `packages/ohbaby-agent/src/sandbox/index.ts`
- Create: `packages/ohbaby-agent/src/sandbox/types.ts`
- Create: `packages/ohbaby-agent/src/sandbox/errors.ts`
- Create: `packages/ohbaby-agent/src/sandbox/adapter-registry.ts`
- Create: `packages/ohbaby-agent/src/sandbox/context.ts`
- Create: `packages/ohbaby-agent/src/sandbox/lease.ts`
- Create: `packages/ohbaby-agent/src/sandbox/manager.ts`
- Create: `packages/ohbaby-agent/src/sandbox/adapters/host-local.ts`
- Create: `packages/ohbaby-agent/src/sandbox/manager.unit.test.ts`
- Create: `packages/ohbaby-agent/src/sandbox/path-boundary.integration.test.ts`

- [ ] **Step 1: Write failing sandbox lifecycle unit tests**

Cover:
- `createContext()` stores active context and rejects duplicates.
- `ensureContext()` is idempotent.
- `acquire()` fails fast when no active context exists.
- Multiple leases increment/decrement lease count.
- `destroyContext()` waits for lease release and then destroys adapter.
- Forced drain after grace period keeps later `release()` idempotent.

Run: `pnpm vitest run packages/ohbaby-agent/src/sandbox/manager.unit.test.ts`
Expected: FAIL because `src/sandbox` does not exist.

- [ ] **Step 2: Write failing sandbox path integration tests**

Use real temp directories:
- `resolvePath()` rejects `..` escape and outside absolute paths.
- `resolvePathForExisting()` rejects symlink/junction escape.
- `resolvePathForWrite()` permits non-existing target under workdir and rejects symlink parent escape.
- `resolveCommandContext()` returns host-local cwd.

Run: `pnpm vitest run packages/ohbaby-agent/src/sandbox/path-boundary.integration.test.ts`
Expected: FAIL because `src/sandbox` does not exist.

- [ ] **Step 3: Implement sandbox manager, lease, and host-local adapter**

Use explicit lifecycle. `acquire()` must not create contexts. Support both `lease.release()` and `manager.release(lease)` so future run-manager integration can stay simple.

- [ ] **Step 4: Verify sandbox tests and commit**

Run:
- `pnpm vitest run packages/ohbaby-agent/src/sandbox/manager.unit.test.ts packages/ohbaby-agent/src/sandbox/path-boundary.integration.test.ts`
- `pnpm run typecheck`

Commit message: `feat(sandbox): add host-local context and leases`

### Task 4: Shell and Command Parser

**Files:**
- Create: `packages/ohbaby-agent/src/shell/index.ts`
- Create: `packages/ohbaby-agent/src/shell/detector.ts`
- Create: `packages/ohbaby-agent/src/shell/process.ts`
- Create: `packages/ohbaby-agent/src/shell/constants.ts`
- Create: `packages/ohbaby-agent/src/shell/shell.unit.test.ts`
- Create: `packages/ohbaby-agent/src/utils/command-parser/index.ts`
- Create: `packages/ohbaby-agent/src/utils/command-parser/types.ts`
- Create: `packages/ohbaby-agent/src/utils/command-parser/parser.ts`
- Create: `packages/ohbaby-agent/src/utils/command-parser/command-parser.unit.test.ts`

- [ ] **Step 1: Write failing shell unit tests**

Cover shell blacklist behavior, platform fallback detection with injected dependencies, Windows Git Bash path derivation, and `killTree()` no-op behavior for exited or pid-less processes.

Run: `pnpm vitest run packages/ohbaby-agent/src/shell/shell.unit.test.ts`
Expected: FAIL because `src/shell` does not exist.

- [ ] **Step 2: Write failing command-parser unit tests**

Cover command roots, wrapper commands such as `sudo`, path detection, parse error flag for unterminated quotes, and wildcard pattern matching.

Run: `pnpm vitest run packages/ohbaby-agent/src/utils/command-parser/command-parser.unit.test.ts`
Expected: FAIL because parser does not exist.

- [ ] **Step 3: Implement shell and MVP parser**

Use no new parser dependency in this batch. The parser is a conservative lexical parser suitable for policy/permission MVP checks; tree-sitter can be a later replacement.

- [ ] **Step 4: Verify shell/parser tests and commit**

Run:
- `pnpm vitest run packages/ohbaby-agent/src/shell/shell.unit.test.ts packages/ohbaby-agent/src/utils/command-parser/command-parser.unit.test.ts`
- `pnpm run typecheck`

Commit message: `feat(shell): add shell utilities and command parser`

### Task 5: Final Verification

**Files:**
- Modify: `packages/ohbaby-agent/src/index.ts`

- [ ] **Step 1: Export new modules from package entry**

Export `project`, `utils`, `sandbox`, and `shell` from `packages/ohbaby-agent/src/index.ts`.

- [ ] **Step 2: Run full verification**

Run:
- `pnpm test`
- `pnpm run typecheck`
- `pnpm run lint`

Expected:
- Tests pass.
- Typecheck passes.
- Full lint may still fail on pre-existing `packages/ohbaby-agent/src/config/llm` debt; verify no new lint errors are introduced by the files touched in this plan.

- [ ] **Step 3: Final review and delivery**

Dispatch final review against the branch diff. Fix Critical/Important feedback before reporting completion.
