# C1 CLI In-Process Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make default `ohbaby` run against an in-process backend, remove the user-facing `--daemon` / `--in-process` flags, and keep explicit remote/server paths available for the later `ohbaby-server` migration.

**Architecture:** C1 changes only the default CLI startup path. `terminal.ts` stops asking for a hidden daemon by default, while `core-api-factory.ts` only auto-spawns a daemon when the internal option `daemon === true` is explicitly passed. Existing server/remote implementation remains in place until the `ohbaby-server` migration branch moves it.

**Tech Stack:** TypeScript, yargs, Vitest, Ink TUI, pnpm workspace, existing `ohbaby-agent` and `ohbaby-cli` packages.

---

## File Map

- Modify `packages/ohbaby-cli/src/cli/commands/terminal.ts`: remove user-facing daemon/in-process options and default to `{ inProcess: true }`.
- Modify `packages/ohbaby-cli/src/bin.unit.test.ts`: update CLI expectations for default startup, resume startup, removed flags, and explicit remote behavior.
- Modify `packages/ohbaby-agent/src/host/core-api-factory.ts`: daemon auto-spawn only when `options.daemon === true`.
- Modify `packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts`: default factory uses local persistent backend; explicit daemon still calls `ensureDaemonRunning`.
- Optionally modify `packages/ohbaby-cli/src/cli/commands/types.ts`: remove only fields that are no longer needed by command parsing, while preserving internal host options if current call sites still need them.
- Modify docs/release notes only after tests pass: update C1 status in `docs/ohbaby-server/c1-cli-inprocess.md` and `docs/ohbaby-server/migration-sequence.md`.

---

### Task 1: Lock Terminal CLI Behavior With Tests

**Files:**
- Modify: `packages/ohbaby-cli/src/bin.unit.test.ts`

- [ ] **Step 1: Change the default terminal expectation**

Find the test that starts the terminal UI through injected runtime dependencies and currently expects:

```ts
expect(createCoreHost).toHaveBeenCalledWith({
  daemon: true,
  mode: "plan",
  permission: "full-access",
});
```

Replace it with:

```ts
expect(createCoreHost).toHaveBeenCalledWith({
  inProcess: true,
  mode: "plan",
  permission: "full-access",
});
```

- [ ] **Step 2: Replace the old `--in-process` positive test**

Find the test named:

```ts
it("uses in-process mode when requested", async () => {
```

Replace the whole test with:

```ts
it("rejects the removed --in-process flag", async () => {
  vi.resetModules();
  const stderr: string[] = [];
  vi.doMock("ohbaby-agent", () => ({
    buildCoreAPIImpl: vi.fn(),
    loadRuntimeEnvIntoProcessEnv: vi.fn(() => Promise.resolve()),
  }));
  vi.doMock("./tui/index.js", () => ({
    renderTerminalUi: vi.fn(),
  }));

  const { runOhbabyCli } = await import("./bin.js");

  await expect(
    runOhbabyCli(["node", "ohbaby", "--in-process"], {
      stderr: { write: (chunk: string) => stderr.push(chunk) },
      stdout: { write: vi.fn() },
    }),
  ).resolves.toBe(2);
  expect(stderr.join("")).toContain("Unknown argument");
});
```

- [ ] **Step 3: Replace the old `--no-daemon` positive test**

Find the test named:

```ts
it("keeps --no-daemon as an alias for in-process mode", async () => {
```

Replace the whole test with:

```ts
it("rejects the removed --daemon flag", async () => {
  vi.resetModules();
  const stderr: string[] = [];
  vi.doMock("ohbaby-agent", () => ({
    buildCoreAPIImpl: vi.fn(),
    loadRuntimeEnvIntoProcessEnv: vi.fn(() => Promise.resolve()),
  }));
  vi.doMock("./tui/index.js", () => ({
    renderTerminalUi: vi.fn(),
  }));

  const { runOhbabyCli } = await import("./bin.js");

  await expect(
    runOhbabyCli(["node", "ohbaby", "--daemon"], {
      stderr: { write: (chunk: string) => stderr.push(chunk) },
      stdout: { write: vi.fn() },
    }),
  ).resolves.toBe(2);
  expect(stderr.join("")).toContain("Unknown argument");
});
```

- [ ] **Step 4: Add a `--no-daemon` rejection test**

Insert this test next to the removed daemon flag test:

```ts
it("rejects the removed --no-daemon alias", async () => {
  vi.resetModules();
  const stderr: string[] = [];
  vi.doMock("ohbaby-agent", () => ({
    buildCoreAPIImpl: vi.fn(),
    loadRuntimeEnvIntoProcessEnv: vi.fn(() => Promise.resolve()),
  }));
  vi.doMock("./tui/index.js", () => ({
    renderTerminalUi: vi.fn(),
  }));

  const { runOhbabyCli } = await import("./bin.js");

  await expect(
    runOhbabyCli(["node", "ohbaby", "--no-daemon"], {
      stderr: { write: (chunk: string) => stderr.push(chunk) },
      stdout: { write: vi.fn() },
    }),
  ).resolves.toBe(2);
  expect(stderr.join("")).toContain("Unknown argument");
});
```

- [ ] **Step 5: Update resume startup expectation**

Find the resume startup test that currently expects:

```ts
expect(createCoreHost).toHaveBeenCalledWith({
  daemon: true,
  resume: "session_2",
});
```

Replace it with:

```ts
expect(createCoreHost).toHaveBeenCalledWith({
  inProcess: true,
  resume: "session_2",
});
```

- [ ] **Step 6: Run the terminal tests and confirm they fail**

Run:

```bash
pnpm exec vitest run packages/ohbaby-cli/src/bin.unit.test.ts --passWithNoTests
```

Expected before implementation: failures showing default calls still include `{ daemon: true }`, and removed flags are still accepted.

---

### Task 2: Implement Terminal Default In-Process Startup

**Files:**
- Modify: `packages/ohbaby-cli/src/cli/commands/terminal.ts`

- [ ] **Step 1: Remove user-facing daemon/in-process options**

Delete these option blocks from the builder:

```ts
.option("in-process", {
  describe: "run the terminal UI against an embedded backend",
  type: "boolean",
})
.option("daemon", {
  describe: "run the terminal UI through the local daemon",
  type: "boolean",
})
```

Also change the remote option descriptions from daemon wording to server wording:

```ts
.option("remote-port", {
  describe: "connect the terminal UI to an explicit server port",
  type: "number",
})
.option("remote-host", {
  default: "127.0.0.1",
  describe: "connect the terminal UI to an explicit server host",
  type: "string",
})
.option("remote-auth-token", {
  describe: "bearer token for an explicit remote server",
  type: "string",
})
```

- [ ] **Step 2: Remove the remote/in-process conflict check**

Delete this block:

```ts
if (
  remotePort !== undefined &&
  (args.inProcess === true || args.daemon === false)
) {
  runtime.failUsage("--remote-port cannot be used with --in-process");
}
const useInProcess = args.inProcess === true || args.daemon === false;
```

- [ ] **Step 3: Simplify host creation**

Replace the nested daemon/in-process selection inside `runtime.createCoreHost` with this shape:

```ts
const host = await runtime.createCoreHost({
  ...(args.continue === true ? { continue: true } : {}),
  ...(remotePort === undefined ? { inProcess: true } : {}),
  ...(args.mode === undefined ? {} : { mode: args.mode }),
  ...(args.permission === undefined ? {} : { permission: args.permission }),
  ...(remotePort === undefined
    ? {}
    : {
        ...(args.remoteAuthToken === undefined
          ? {}
          : { remoteAuthToken: args.remoteAuthToken }),
        remoteHost: normalizeRemoteHost(args.remoteHost),
        remotePort,
      }),
  ...(resume === undefined ? {} : { resume }),
});
```

- [ ] **Step 4: Run the terminal tests**

Run:

```bash
pnpm exec vitest run packages/ohbaby-cli/src/bin.unit.test.ts --passWithNoTests
```

Expected after implementation: terminal tests pass or reveal only type/test cleanup around removed flags.

---

### Task 3: Lock Core API Factory Behavior With Tests

**Files:**
- Modify: `packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts`

- [ ] **Step 1: Replace the default auto-spawn test**

Find:

```ts
it("uses an auto-spawned daemon by default", async () => {
```

Replace it with a local default test:

```ts
it("uses the in-process persistent backend by default", async () => {
  vi.resetModules();
  const client = createMockClient();
  const createPersistentUiBackendClient = vi.fn(() => client);
  const ensureDaemonRunning = vi.fn();
  const createRemoteCoreApiHost = vi.fn();
  vi.doMock("../runtime/daemon/client.js", () => ({
    createRemoteCoreApiHost,
  }));
  vi.doMock("../runtime/daemon/spawn.js", () => ({
    ensureDaemonRunning,
  }));
  vi.doMock("../adapters/ui-persistent.js", () => ({
    closePersistentUiBackendDatabase: vi.fn(),
    createPersistentUiBackendClient,
  }));
  vi.doMock("../mcp/index.js", () => ({
    McpManager: { disposeAll: vi.fn(() => Promise.resolve()) },
  }));

  const { buildCoreAPIImpl } = await import("./core-api-factory.js");

  const host = await buildCoreAPIImpl({});
  expect(createPersistentUiBackendClient).toHaveBeenCalledWith({});
  expect(ensureDaemonRunning).not.toHaveBeenCalled();
  expect(createRemoteCoreApiHost).not.toHaveBeenCalled();
  await expect(host.dispose()).resolves.toBeUndefined();
});
```

Use the existing local test helpers in the file. If there is no `createMockClient()` helper with the methods required by `buildCoreAPIImpl`, extract one from the existing in-process tests rather than creating a partial object that breaks type expectations.

- [ ] **Step 2: Add explicit daemon opt-in test**

Add this test after the default local test:

```ts
it("uses an auto-spawned daemon only when daemon is explicitly true", async () => {
  vi.resetModules();
  const remoteHost = {
    callbacks: { subscribeEvents: vi.fn() },
    core: {},
    dispose: vi.fn(() => Promise.resolve()),
  };
  const createRemoteCoreApiHost = vi.fn(() => remoteHost);
  const ensureDaemonRunning = vi.fn(() =>
    Promise.resolve({
      authToken: "token_1",
      host: "127.0.0.1",
      packageVersion: "0.1.0",
      port: 4096,
    }),
  );
  const createPersistentUiBackendClient = vi.fn();
  vi.doMock("../runtime/daemon/client.js", () => ({
    createRemoteCoreApiHost,
  }));
  vi.doMock("../runtime/daemon/spawn.js", () => ({
    ensureDaemonRunning,
  }));
  vi.doMock("../package-version.js", () => ({
    getAgentPackageVersion: (): string => "9.9.9",
  }));
  vi.doMock("../adapters/ui-persistent.js", () => ({
    closePersistentUiBackendDatabase: vi.fn(),
    createPersistentUiBackendClient,
  }));
  vi.doMock("../mcp/index.js", () => ({
    McpManager: { disposeAll: vi.fn(() => Promise.resolve()) },
  }));

  const { buildCoreAPIImpl } = await import("./core-api-factory.js");

  await expect(buildCoreAPIImpl({ daemon: true })).resolves.toBe(remoteHost);
  expect(ensureDaemonRunning).toHaveBeenCalledWith({
    currentVersion: "9.9.9",
  });
  expect(createRemoteCoreApiHost).toHaveBeenCalledWith({
    authToken: "token_1",
    host: "127.0.0.1",
    port: 4096,
    startupIntent: { startupSessionMode: { type: "fresh" } },
  });
  expect(createPersistentUiBackendClient).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the factory tests and confirm failure before implementation**

Run:

```bash
pnpm exec vitest run packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts --passWithNoTests
```

Expected before implementation: the default local test fails because the factory still calls `ensureDaemonRunning()`.

---

### Task 4: Implement Factory Default In-Process Behavior

**Files:**
- Modify: `packages/ohbaby-agent/src/host/core-api-factory.ts`

- [ ] **Step 1: Change the daemon branch condition**

Replace:

```ts
if (options.inProcess !== true && options.daemon !== false) {
```

with:

```ts
if (options.daemon === true) {
```

- [ ] **Step 2: Keep explicit remote behavior unchanged**

Do not alter this branch:

```ts
if (options.remotePort !== undefined) {
  return createRemoteCoreApiHost({
    authToken: options.remoteAuthToken,
    host: options.remoteHost,
    port: options.remotePort,
    startupIntent,
  });
}
```

This preserves `ohbaby --remote-port` until the later `ohbaby-server` migration moves the remote client.

- [ ] **Step 3: Run factory tests**

Run:

```bash
pnpm exec vitest run packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts --passWithNoTests
```

Expected: all factory tests pass.

---

### Task 5: Clean Up Types Without Breaking Internal Host Options

**Files:**
- Inspect: `packages/ohbaby-cli/src/cli/commands/types.ts`
- Modify only if TypeScript indicates unused or misleading CLI-facing fields.

- [ ] **Step 1: Run typecheck after Tasks 2 and 4**

Run:

```bash
pnpm run typecheck
```

Expected: TypeScript points out whether `daemon`, `inProcess`, or `noDaemon` can be removed from CLI command types.

- [ ] **Step 2: Preserve internal host options if needed**

If `run.ts` or test helpers still pass internal host options:

```ts
{
  daemon: false,
  inProcess: true
}
```

do not delete the internal option type yet. C1 removes user-facing flags; it does not require deleting every internal field before the `ohbaby-server` migration.

- [ ] **Step 3: Remove only the dead `noDaemon` field if safe**

If `rg -n "noDaemon" packages/ohbaby-cli/src` only finds the type declaration, remove:

```ts
readonly noDaemon?: boolean;
```

Run:

```bash
pnpm run typecheck
```

Expected: typecheck still passes.

---

### Task 6: Update C1 Documentation and Release Notes Draft

**Files:**
- Modify: `docs/ohbaby-server/c1-cli-inprocess.md`
- Modify: `docs/ohbaby-server/migration-sequence.md`
- Modify: `README.md` only if it currently documents `--daemon` or `--in-process`

- [ ] **Step 1: Mark C1 implementation status**

In `docs/ohbaby-server/c1-cli-inprocess.md`, add this near the top after the intro block:

```md
> **Implementation status:** Implemented on `work/v0.1.4-c1-inprocess`; awaiting server migration, full regression, real API key verification, and user environment testing before v0.1.4 release.
```

- [ ] **Step 2: Add release notes draft text**

In the same document, add a section:

```md
## Release notes draft

- Default `ohbaby` now runs in-process and no longer auto-spawns a hidden daemon.
- Removed `--daemon` and `--in-process`; these flags were internal implementation details and are no longer part of the CLI surface.
- Explicit server usage remains available through `ohbaby serve` and explicit remote connection options.
```

- [ ] **Step 3: Search README for removed flags**

Run:

```bash
rg -n "--daemon|--in-process|no-daemon" README.md docs packages
```

Expected: only historical docs or release notes mention removed flags. User-facing install/start sections should not recommend them.

---

### Task 7: Verification and Commit

**Files:**
- All files changed by Tasks 1-6.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm exec vitest run packages/ohbaby-cli/src/bin.unit.test.ts packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts --passWithNoTests
```

Expected: both files pass.

- [ ] **Step 2: Run CLI command tests affected by serve/terminal behavior**

Run:

```bash
pnpm exec vitest run packages/ohbaby-cli/src/cli/commands/serve.unit.test.ts packages/ohbaby-cli/src/cli/commands/run.unit.test.ts --passWithNoTests
```

Expected: both files pass. These ensure `run` remains in-process and `serve` remains available.

- [ ] **Step 3: Run broader checks**

Run:

```bash
pnpm run lint
pnpm run typecheck
pnpm run test:unit
```

Expected: all pass. If `test:unit` is too slow but still running normally, let it finish; do not replace it with a narrower check.

- [ ] **Step 4: Inspect daemon auto-spawn reachability**

Run:

```bash
rg -n "ensureDaemonRunning|daemon: true|--daemon|--in-process" packages/ohbaby-cli/src packages/ohbaby-agent/src
```

Expected:

- `ensureDaemonRunning` remains only in factory/spawn code and explicit tests.
- `daemon: true` remains only in explicit daemon opt-in tests or later server migration code.
- `--daemon` and `--in-process` no longer appear in user-facing terminal command code.

- [ ] **Step 5: Commit C1**

Run:

```bash
git status --short
git add packages/ohbaby-cli/src/cli/commands/terminal.ts packages/ohbaby-cli/src/bin.unit.test.ts packages/ohbaby-agent/src/host/core-api-factory.ts packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts docs/ohbaby-server/c1-cli-inprocess.md docs/ohbaby-server/migration-sequence.md
git commit -m "feat: default cli to in-process runtime"
```

Expected: commit succeeds after hooks run `lint` and `typecheck`.

---

## Plan Self-Review

- Spec coverage: covers C1 default in-process, flag removal, explicit remote preservation, tests, docs, and release-note wording.
- Server migration excluded deliberately: `ohbaby-server` package migration has separate docs and should get a separate implementation plan.
- Dependency direction preserved: no step makes `ohbaby-agent` import `ohbaby-server`.
- No hidden compatibility path: user-facing `--daemon`, `--no-daemon`, and `--in-process` are rejected.
