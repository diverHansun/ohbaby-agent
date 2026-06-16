# ohbaby-server Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a buildable `ohbaby-server` workspace package, move low-risk server primitives into it, and wire explicit CLI server/remote paths through that package without making the default `ohbaby` path depend on it.

**Architecture:** This is the v0.1.4 server package landing step, not the final daemon deletion. `ohbaby-cli` will keep default terminal startup local/in-process via `ohbaby-agent`; explicit `serve` and `--remote-port` paths will resolve through `ohbaby-server`. To avoid a risky big-bang move, `ohbaby-server` first owns pure protocol/auth/coordination primitives and temporarily delegates lifecycle/server HTTP functions to existing `ohbaby-agent` exports until the deeper `runtime/daemon/server.ts` split is done in a later cleanup.

**Tech Stack:** TypeScript, pnpm workspace, tsup, Vitest, yargs, existing `ohbaby-agent` and `ohbaby-sdk` package contracts.

---

## File Map

- Create `packages/ohbaby-server/package.json`: publishable workspace package metadata and scripts.
- Create `packages/ohbaby-server/tsconfig.json`: project reference to `ohbaby-sdk` and `ohbaby-agent`.
- Create `packages/ohbaby-server/tsup.config.ts`: ESM build entry.
- Create `packages/ohbaby-server/README.md`: developer-facing package note.
- Create `packages/ohbaby-server/src/index.ts`: narrow public package surface.
- Create `packages/ohbaby-server/src/auth/token.ts`: copied auth token helpers from daemon auth.
- Create `packages/ohbaby-server/src/auth/token.unit.test.ts`: copied/renamed auth unit tests.
- Create `packages/ohbaby-server/src/protocols/jsonrpc/protocol.ts`: copied JSON-RPC/SSE envelope helpers from daemon protocol.
- Create `packages/ohbaby-server/src/protocols/jsonrpc/protocol.unit.test.ts`: copied protocol unit tests.
- Create `packages/ohbaby-server/src/coordination/prompt-queue.ts`: copied prompt queue.
- Create `packages/ohbaby-server/src/coordination/prompt-queue.unit.test.ts`: copied prompt queue tests.
- Create `packages/ohbaby-server/src/coordination/permission-router.ts`: copied permission router.
- Create `packages/ohbaby-server/src/coordination/permission-router.unit.test.ts`: copied permission router tests.
- Create `packages/ohbaby-server/src/public-api.unit.test.ts`: public surface and delegation test.
- Modify root `tsconfig.json`: add project reference before `ohbaby-cli`.
- Modify `packages/ohbaby-cli/package.json`: add `ohbaby-server` workspace dependency.
- Modify `packages/ohbaby-cli/tsconfig.json`: add `../ohbaby-server` project reference.
- Modify `packages/ohbaby-cli/tsup.config.ts`: externalize `ohbaby-server`.
- Modify `packages/ohbaby-cli/src/bin.ts`: load `ohbaby-agent` for local core and `ohbaby-server` for explicit server/remote paths.
- Modify `packages/ohbaby-cli/src/bin.unit.test.ts`: verify default terminal does not require `ohbaby-server`; verify serve and remote use `ohbaby-server`.
- Modify `docs/ohbaby-server/package-build.md` and `docs/ohbaby-server/migration-sequence.md`: record transitional v0.1.4 state.

---

### Task 1: Create Buildable Package Skeleton

**Files:**
- Create: `packages/ohbaby-server/package.json`
- Create: `packages/ohbaby-server/tsconfig.json`
- Create: `packages/ohbaby-server/tsup.config.ts`
- Create: `packages/ohbaby-server/README.md`
- Create: `packages/ohbaby-server/src/index.ts`
- Modify: `tsconfig.json`

- [ ] **Step 1: Add the package metadata**

Create `packages/ohbaby-server/package.json` with:

```json
{
  "name": "ohbaby-server",
  "version": "0.1.3",
  "description": "Explicit local server and remote client adapters for ohbaby",
  "type": "module",
  "publishConfig": {
    "access": "public"
  },
  "engines": {
    "node": ">=24.0.0"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "dist/**/*.js",
    "dist/**/*.js.map",
    "dist/**/*.d.ts",
    "dist/**/*.d.ts.map",
    "!dist/**/*.test.d.ts",
    "!dist/**/*.test.d.ts.map",
    "!dist/**/*.unit.test.d.ts",
    "!dist/**/*.unit.test.d.ts.map",
    "!dist/**/*.contract.test.d.ts",
    "!dist/**/*.contract.test.d.ts.map",
    "!dist/**/*.integration.test.d.ts",
    "!dist/**/*.integration.test.d.ts.map",
    "README.md"
  ],
  "sideEffects": false,
  "scripts": {
    "build": "rimraf dist && tsup && tsc -b --force",
    "typecheck": "tsc -b",
    "clean": "rimraf dist coverage"
  },
  "dependencies": {
    "ohbaby-agent": "workspace:*",
    "ohbaby-sdk": "workspace:*"
  }
}
```

Use `0.1.3` for now because the workspace is still `0.1.3`; bump all public packages to `0.1.4` in the final release commit only.

- [ ] **Step 2: Add TypeScript project config**

Create `packages/ohbaby-server/tsconfig.json` with:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "emitDeclarationOnly": true,
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "coverage", "node_modules"],
  "references": [
    {
      "path": "../ohbaby-sdk"
    },
    {
      "path": "../ohbaby-agent"
    }
  ]
}
```

- [ ] **Step 3: Add tsup config**

Create `packages/ohbaby-server/tsup.config.ts` with:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "node20",
  outDir: "dist",
  treeshake: true,
  minify: false,
  shims: true,
  external: ["ohbaby-agent", "ohbaby-sdk"],
});
```

- [ ] **Step 4: Add package README**

Create `packages/ohbaby-server/README.md` with:

```md
# ohbaby-server

Explicit local server and remote client adapters for `ohbaby`.

End users should install `ohbaby-cli` and run `ohbaby`. This package is a library dependency used by the CLI for explicit server/remote scenarios such as `ohbaby serve` and `ohbaby --remote-port`.
```

- [ ] **Step 5: Add an initial public index**

Create `packages/ohbaby-server/src/index.ts` with:

```ts
export {
  createDaemonAuthToken,
  daemonAuthHeader,
  isAuthorizedDaemonRequest,
  redactDaemonAuthToken,
} from "./auth/token.js";
export * from "./protocols/jsonrpc/protocol.js";
export {
  DaemonPromptQueue,
  DaemonPromptQueueShutdownError,
} from "./coordination/prompt-queue.js";
export type {
  DaemonPromptQueueItem,
  DaemonPromptQueueOptions,
} from "./coordination/prompt-queue.js";
export { PermissionRouter } from "./coordination/permission-router.js";
export {
  createRemoteCoreApiHost,
  createRemoteUiBackendClient,
  readDaemonStatus,
  startDaemonServer,
  stopDaemonFromState,
} from "ohbaby-agent";
export type {
  CoreApiHost,
  DaemonState,
  RunningDaemonServer,
  StartDaemonServerOptions,
} from "ohbaby-agent";
```

The re-export from `ohbaby-agent` is an explicit transitional adapter. It keeps `ohbaby-agent -> ohbaby-server` forbidden, while letting `ohbaby-cli` depend on `ohbaby-server` for explicit server paths.

- [ ] **Step 6: Add the root TypeScript reference**

Modify root `tsconfig.json` to include:

```json
{
  "path": "./packages/ohbaby-server"
}
```

Place it after `ohbaby-agent` and before `ohbaby-cli`.

- [ ] **Step 7: Run package build and expect failure before primitives exist**

Run:

```bash
pnpm --filter ohbaby-server build
```

Expected: fail with missing module errors for `./auth/token.js`, `./protocols/jsonrpc/protocol.js`, `./coordination/prompt-queue.js`, and `./coordination/permission-router.js`.

---

### Task 2: Move Low-Risk Server Primitives Into ohbaby-server

**Files:**
- Create: `packages/ohbaby-server/src/auth/token.ts`
- Create: `packages/ohbaby-server/src/auth/token.unit.test.ts`
- Create: `packages/ohbaby-server/src/protocols/jsonrpc/protocol.ts`
- Create: `packages/ohbaby-server/src/protocols/jsonrpc/protocol.unit.test.ts`
- Create: `packages/ohbaby-server/src/coordination/prompt-queue.ts`
- Create: `packages/ohbaby-server/src/coordination/prompt-queue.unit.test.ts`
- Create: `packages/ohbaby-server/src/coordination/permission-router.ts`
- Create: `packages/ohbaby-server/src/coordination/permission-router.unit.test.ts`

- [ ] **Step 1: Copy auth implementation and tests**

Mechanically copy:

```text
packages/ohbaby-agent/src/runtime/daemon/auth.ts
  -> packages/ohbaby-server/src/auth/token.ts
packages/ohbaby-agent/src/runtime/daemon/auth.unit.test.ts
  -> packages/ohbaby-server/src/auth/token.unit.test.ts
```

Then update the test import from:

```ts
} from "./auth.js";
```

to:

```ts
} from "./token.js";
```

- [ ] **Step 2: Copy protocol implementation and tests**

Mechanically copy:

```text
packages/ohbaby-agent/src/runtime/daemon/protocol.ts
  -> packages/ohbaby-server/src/protocols/jsonrpc/protocol.ts
packages/ohbaby-agent/src/runtime/daemon/protocol.unit.test.ts
  -> packages/ohbaby-server/src/protocols/jsonrpc/protocol.unit.test.ts
```

No import changes should be needed unless the copied test imports `./protocol.js`.

- [ ] **Step 3: Copy prompt queue implementation and tests**

Mechanically copy:

```text
packages/ohbaby-agent/src/runtime/daemon/prompt-queue.ts
  -> packages/ohbaby-server/src/coordination/prompt-queue.ts
packages/ohbaby-agent/src/runtime/daemon/prompt-queue.unit.test.ts
  -> packages/ohbaby-server/src/coordination/prompt-queue.unit.test.ts
```

No import changes should be needed unless the copied test imports `./prompt-queue.js`.

- [ ] **Step 4: Copy permission router implementation and tests**

Mechanically copy:

```text
packages/ohbaby-agent/src/runtime/daemon/permission-router.ts
  -> packages/ohbaby-server/src/coordination/permission-router.ts
packages/ohbaby-agent/src/runtime/daemon/permission-router.unit.test.ts
  -> packages/ohbaby-server/src/coordination/permission-router.unit.test.ts
```

No import changes should be needed unless the copied test imports `./permission-router.js`.

- [ ] **Step 5: Run primitive unit tests**

Run:

```bash
pnpm exec vitest run packages/ohbaby-server/src/auth/token.unit.test.ts packages/ohbaby-server/src/protocols/jsonrpc/protocol.unit.test.ts packages/ohbaby-server/src/coordination/prompt-queue.unit.test.ts packages/ohbaby-server/src/coordination/permission-router.unit.test.ts --passWithNoTests
```

Expected: all copied primitive tests pass. If a test fails because a relative import still points at an old file name, fix only that import.

- [ ] **Step 6: Build the package**

Run:

```bash
pnpm --filter ohbaby-server build
```

Expected: build passes.

---

### Task 3: Wire CLI Explicit Server Paths Through ohbaby-server

**Files:**
- Modify: `packages/ohbaby-cli/package.json`
- Modify: `packages/ohbaby-cli/tsconfig.json`
- Modify: `packages/ohbaby-cli/tsup.config.ts`
- Modify: `packages/ohbaby-cli/src/bin.ts`
- Modify: `packages/ohbaby-cli/src/bin.unit.test.ts`

- [ ] **Step 1: Add CLI dependency and TS reference**

In `packages/ohbaby-cli/package.json`, add:

```json
"ohbaby-server": "workspace:*"
```

beside `ohbaby-agent` and `ohbaby-sdk`.

In `packages/ohbaby-cli/tsconfig.json`, add:

```json
{
  "path": "../ohbaby-server"
}
```

after the `../ohbaby-sdk` reference.

In `packages/ohbaby-cli/tsup.config.ts`, add `"ohbaby-server"` to `external`.

- [ ] **Step 2: Extend runtime module types**

In `packages/ohbaby-cli/src/bin.ts`, add:

```ts
const SERVER_RUNTIME_MODULE = "ohbaby-server";
```

and add this interface:

```ts
interface ServerRuntimeModule {
  readonly createRemoteCoreApiHost?: unknown;
  readonly readDaemonStatus?: unknown;
  readonly startDaemonServer?: unknown;
  readonly stopDaemonFromState?: unknown;
}
```

- [ ] **Step 3: Load server runtime separately from agent runtime**

In `loadDefaultDependencies()`, import both modules:

```ts
const runtimeModule = (await importRuntimeModule(
  AGENT_RUNTIME_MODULE,
)) as AgentRuntimeModule;
const serverModule = (await importRuntimeModule(
  SERVER_RUNTIME_MODULE,
)) as ServerRuntimeModule;
```

Require `buildCoreAPIImpl` and `loadRuntimeEnvIntoProcessEnv` from `runtimeModule` as before.

Require server functions from `serverModule`:

```ts
const createRemoteCoreApiHost = requireFunction(
  serverModule.createRemoteCoreApiHost,
  "createRemoteCoreApiHost",
  SERVER_RUNTIME_MODULE,
) as (options: CliGlobalOptions) => CliCoreHost | Promise<CliCoreHost>;
const readDaemonStatus = requireFunction(
  serverModule.readDaemonStatus,
  "readDaemonStatus",
  SERVER_RUNTIME_MODULE,
) as CliCommandRuntime["readDaemonStatus"];
const startDaemonServer = requireFunction(
  serverModule.startDaemonServer,
  "startDaemonServer",
  SERVER_RUNTIME_MODULE,
) as CliCommandRuntime["startDaemonServer"];
const stopDaemonFromState = requireFunction(
  serverModule.stopDaemonFromState,
  "stopDaemonFromState",
  SERVER_RUNTIME_MODULE,
) as CliCommandRuntime["stopDaemonFromState"];
```

Update `requireFunction()` to accept the module name:

```ts
function requireFunction(
  value: unknown,
  name: string,
  moduleName: string,
): (...args: unknown[]) => unknown {
  if (typeof value !== "function") {
    throw new Error(`Missing ${name} export from ${moduleName}`);
  }
  return value as (...args: unknown[]) => unknown;
}
```

Update existing `requireFunction(...)` callers to pass `AGENT_RUNTIME_MODULE`.

- [ ] **Step 4: Route remote host creation through server runtime**

Return this `createCoreHost` implementation from `loadDefaultDependencies()`:

```ts
createCoreHost(options): CliCoreHost | Promise<CliCoreHost> {
  if (options.remotePort !== undefined) {
    return createRemoteCoreApiHost(options);
  }
  return buildCoreAPIImpl(options);
}
```

This keeps default `ohbaby` local/in-process while routing explicit `--remote-port` through `ohbaby-server`.

- [ ] **Step 5: Add failing CLI dependency tests**

In `packages/ohbaby-cli/src/bin.unit.test.ts`, add a test that the default terminal path can start when `ohbaby-server` exists but is not used:

```ts
vi.doMock("ohbaby-server", () => ({
  createRemoteCoreApiHost: vi.fn(() => {
    throw new Error("remote server host should not be used for default terminal");
  }),
  readDaemonStatus: vi.fn(),
  startDaemonServer: vi.fn(),
  stopDaemonFromState: vi.fn(),
}));
```

and assert the default terminal `createCoreHost` call still gets `{ inProcess: true }`.

Add a remote test where `ohbaby-agent.buildCoreAPIImpl` throws if called and `ohbaby-server.createRemoteCoreApiHost` returns the mock host:

```ts
expect(createRemoteCoreApiHost).toHaveBeenCalledWith({
  remoteHost: "127.0.0.1",
  remotePort: 4096
});
```

Add a serve test where `ohbaby-server.startDaemonServer` is called and `ohbaby-agent` only provides `buildCoreAPIImpl` / `loadRuntimeEnvIntoProcessEnv`.

- [ ] **Step 6: Run CLI tests and confirm failure before implementation**

Run:

```bash
pnpm exec vitest run packages/ohbaby-cli/src/bin.unit.test.ts --passWithNoTests
```

Expected before bin implementation: failures due missing `ohbaby-server` loading/usage.

- [ ] **Step 7: Implement bin wiring and rerun tests**

Run:

```bash
pnpm exec vitest run packages/ohbaby-cli/src/bin.unit.test.ts packages/ohbaby-cli/src/cli/commands/serve.unit.test.ts --passWithNoTests
```

Expected: CLI default/remote/serve tests pass.

---

### Task 4: Public API and Dependency Direction Guard

**Files:**
- Create: `packages/ohbaby-server/src/public-api.unit.test.ts`
- Modify: `docs/ohbaby-server/package-build.md`
- Modify: `docs/ohbaby-server/migration-sequence.md`

- [ ] **Step 1: Add public API smoke test**

Create `packages/ohbaby-server/src/public-api.unit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DaemonPromptQueue,
  PermissionRouter,
  createDaemonAuthToken,
  createRemoteCoreApiHost,
  daemonAuthHeader,
  readDaemonStatus,
  startDaemonServer,
  stopDaemonFromState,
} from "./index.js";

describe("ohbaby-server public API", () => {
  it("exports explicit server and remote entrypoints", () => {
    expect(createDaemonAuthToken).toBeTypeOf("function");
    expect(daemonAuthHeader).toBeTypeOf("function");
    expect(DaemonPromptQueue).toBeTypeOf("function");
    expect(PermissionRouter).toBeTypeOf("function");
    expect(createRemoteCoreApiHost).toBeTypeOf("function");
    expect(readDaemonStatus).toBeTypeOf("function");
    expect(startDaemonServer).toBeTypeOf("function");
    expect(stopDaemonFromState).toBeTypeOf("function");
  });
});
```

- [ ] **Step 2: Add dependency direction inspection**

Run:

```bash
rg -n "ohbaby-server" packages/ohbaby-agent/src packages/ohbaby-agent/package.json
```

Expected: no matches. `ohbaby-agent` must not depend on `ohbaby-server`.

- [ ] **Step 3: Update server docs**

In `docs/ohbaby-server/package-build.md`, add a "v0.1.4 transitional state" note:

```md
> **v0.1.4 transitional state:** `ohbaby-server` owns copied auth/protocol/coordination primitives and exposes explicit server/remote entrypoints. Lifecycle/HTTP server implementation still delegates to existing `ohbaby-agent` exports until the deeper `runtime/daemon/server.ts` split is completed. This keeps default CLI in-process and avoids expanding `ohbaby-agent`'s dependency direction.
```

In `docs/ohbaby-server/migration-sequence.md`, update Stage S to mark S0/S1 landed and S2/S3 as remaining cleanup:

```md
当前状态：S0 package skeleton and S1 low-risk primitives are implemented. Explicit CLI server/remote paths resolve through `ohbaby-server`; deeper lifecycle/server file relocation remains a follow-up before removing old daemon internals.
```

---

### Task 5: Verification and Commit

**Files:**
- All files changed by Tasks 1-4.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm exec vitest run packages/ohbaby-server/src/**/*.unit.test.ts packages/ohbaby-cli/src/bin.unit.test.ts packages/ohbaby-cli/src/cli/commands/serve.unit.test.ts --passWithNoTests
```

Expected: all focused tests pass.

- [ ] **Step 2: Run package build and typecheck**

Run:

```bash
pnpm --filter ohbaby-server build
pnpm run typecheck
```

Expected: both pass.

- [ ] **Step 3: Run broader checks**

Run:

```bash
pnpm run lint
pnpm run test:unit
pnpm run build
```

Expected: all pass. Existing Node SQLite experimental warnings are acceptable only if there are zero test failures.

- [ ] **Step 4: Inspect dependency and default CLI reachability**

Run:

```bash
rg -n "ohbaby-server" packages/ohbaby-agent/src packages/ohbaby-agent/package.json
rg -n "SERVER_RUNTIME_MODULE|ohbaby-server|remotePort" packages/ohbaby-cli/src/bin.ts
rg -n "ensureDaemonRunning|daemon: true|--daemon|--in-process" packages/ohbaby-cli/src packages/ohbaby-agent/src packages/ohbaby-server/src
```

Expected:

- No `ohbaby-server` matches in `ohbaby-agent`.
- `ohbaby-cli/src/bin.ts` imports/loads `ohbaby-server` only for explicit server/remote dependencies.
- Removed terminal flags appear only in rejection tests or docs, not command builders.

- [ ] **Step 5: Commit**

Run:

```bash
git status --short
git add packages/ohbaby-server tsconfig.json packages/ohbaby-cli/package.json packages/ohbaby-cli/tsconfig.json packages/ohbaby-cli/tsup.config.ts packages/ohbaby-cli/src/bin.ts packages/ohbaby-cli/src/bin.unit.test.ts docs/ohbaby-server/package-build.md docs/ohbaby-server/migration-sequence.md
git commit -m "feat: add ohbaby-server package boundary"
```

Expected: commit succeeds after hooks run `lint` and `typecheck`.

---

## Plan Self-Review

- Spec coverage: implements the second v0.1.4 stage as a publishable package boundary, keeps default CLI in-process, removes user-facing daemon/in-process mode semantics from default startup, and routes explicit server responsibilities through the server package.
- Risk control: avoids moving `server.ts`/`main.ts` wholesale until their agent-internal dependencies are explicitly narrowed; documents this as transitional, not final.
- Dependency direction: `ohbaby-server -> ohbaby-agent` is allowed; `ohbaby-agent -> ohbaby-server` is forbidden and guarded by `rg`.
- TDD coverage: package public API, copied primitives, CLI default/remote/serve behavior, typecheck, lint, unit, build.
- No placeholders: every task has concrete files, commands, and expected results.
