# Phase 3 Implementation Plan: Explicit Daemon And Remote UI Client

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for every production change and `superpowers:verification-before-completion` before every completion claim. This plan is scoped to Phase 3 only.

**Goal:** Make `ohbaby serve` start an explicit local daemon, and let `ohbaby --remote-port <port>` connect the terminal UI to that daemon through the same `CoreAPI`/`SDKAPI` contract used by the in-process backend.

**Architecture:** Phase 3 keeps daemon startup explicit. The daemon owns one persistent `UiBackendClient` instance, exposes CoreAPI methods through local HTTP JSON-RPC, and streams `UiEvent` updates to remote clients over Server-Sent Events (SSE). Auto-spawn, default daemon mode, strict cross-terminal FIFO, and backend lease retirement stay in Phase 4.

**Tech Stack:** TypeScript, Node.js `http`, Node.js `fetch`, Server-Sent Events, Vitest, yargs, existing `UiBackendClient`, existing persistent backend, existing Ink TUI.

---

## Scope Boundary

In scope:

- `ohbaby serve --port 4096` starts a foreground daemon server.
- `ohbaby serve status` reports the supervisor state file.
- `ohbaby serve stop` requests graceful shutdown of the recorded daemon process.
- `ohbaby --remote-port 4096` connects the terminal UI to the explicit daemon.
- Remote clients support the complete `CoreAPI` method set and `SDKAPI.subscribeEvents`.
- Permission requests are interactive only for the client that initiated the run.
- Observing clients continue to receive non-interactive session/run/message events.

Out of scope:

- Default `pnpm start` auto-spawns or auto-connects to daemon.
- Cross-terminal strict FIFO. Phase 3 has one daemon backend, but global prompt queue ownership is Phase 4.
- WebSocket transport. Phase 3 uses HTTP + SSE to avoid new dependencies and remain web/app friendly.
- ACP/A2A.
- Backend lease retention/retirement. Phase 4 Task 4.6 owns that decision.

## File Structure

Create:

- `packages/ohbaby-agent/src/runtime/daemon/protocol.ts` - JSON-RPC request/response and SSE event envelope types, plus runtime validators.
- `packages/ohbaby-agent/src/runtime/daemon/protocol.unit.test.ts` - serialization and validator tests.
- `packages/ohbaby-agent/src/runtime/daemon/permission-router.ts` - client/run ownership map and event/snapshot filtering for permission requests.
- `packages/ohbaby-agent/src/runtime/daemon/permission-router.unit.test.ts` - owner mapping and permission filtering tests.
- `packages/ohbaby-agent/src/runtime/daemon/server.ts` - local HTTP JSON-RPC server and SSE event fanout.
- `packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts` - daemon server with fake and persistent backends.
- `packages/ohbaby-agent/src/runtime/daemon/client.ts` - remote `CoreApiHost` / `UiBackendClient` implementation.
- `packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts` - remote client against the daemon server.
- `packages/ohbaby-agent/src/runtime/daemon/main.ts` - explicit serve runtime around persistent backend, HTTP server, and `Supervisor`.
- `tests/integration/cli/daemon-terminal.integration.test.ts` - CLI-level explicit daemon connection path.

Modify:

- `packages/ohbaby-agent/src/runtime/daemon/index.ts` - export protocol, server, client, main helpers.
- `packages/ohbaby-agent/src/host/core-api-factory.ts` - route remote options to the remote daemon client.
- `packages/ohbaby-agent/src/index.ts` - export remote daemon helpers through package root if needed by CLI tests.
- `packages/ohbaby-cli/src/cli/commands/types.ts` - add remote daemon options to CLI runtime types.
- `packages/ohbaby-cli/src/cli/commands/terminal.ts` - add `--remote-port` and `--remote-host`.
- `packages/ohbaby-cli/src/cli/commands/serve.ts` - replace stub with explicit daemon start/status/stop.
- `packages/ohbaby-cli/src/bin.ts` - pass remote options and load daemon helpers through `buildCoreAPIImpl`.
- `packages/ohbaby-cli/src/bin.unit.test.ts` - option parsing coverage.
- `packages/ohbaby-cli/src/cli/commands/serve.unit.test.ts` - serve command behavior.
- `docs/problem-lists/terminal-daemon/02-solution-design.md` - sync Phase 3 transport to HTTP/SSE and keep auto-spawn in Phase 4.
- `docs/problem-lists/terminal-daemon/04-test-criteria.md` - sync Phase 3 test criteria to HTTP/SSE and Phase 4 preview.
- `docs/problem-lists/terminal-daemon/05-implementation-plan.md` - mark Phase 3 task checkboxes as they complete.
- `docs/problem-lists/terminal-daemon/07-phase-3-execution-plan.md` - mark this plan as tasks complete.

## Task 3.1: Protocol Contract

**Files:**

- Create: `packages/ohbaby-agent/src/runtime/daemon/protocol.ts`
- Create: `packages/ohbaby-agent/src/runtime/daemon/protocol.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/index.ts`

- [x] Write failing tests for all protocol envelopes.

Test cases:

- `createDaemonRpcRequest("getSnapshot", [])` serializes to `{ id, method, params }`.
- `parseDaemonRpcRequest` accepts supported methods and rejects unknown methods.
- `createDaemonRpcSuccess` and `createDaemonRpcFailure` round-trip through JSON.
- `parseDaemonSseEvent` accepts `ui.event`, `hello`, and `error` event payloads.
- The supported method list covers every `CoreAPI` method: `getSnapshot`, `getContextWindowUsage`, `listCommands`, `submitPrompt`, `compactSession`, `getCurrentModel`, `connectModel`, `executeCommand`, `respondPermission`, `respondInteraction`, `abortRun`.

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/protocol.unit.test.ts
```

Expected RED: fails because `protocol.ts` does not exist.

- [x] Implement `protocol.ts`.

Required public API:

```ts
export const DAEMON_RPC_METHODS = [
  "getSnapshot",
  "getContextWindowUsage",
  "listCommands",
  "submitPrompt",
  "compactSession",
  "getCurrentModel",
  "connectModel",
  "executeCommand",
  "respondPermission",
  "respondInteraction",
  "abortRun",
] as const;

export type DaemonRpcMethod = (typeof DAEMON_RPC_METHODS)[number];

export interface DaemonRpcRequest {
  readonly id: string;
  readonly clientId: string;
  readonly method: DaemonRpcMethod;
  readonly params: readonly unknown[];
}

export type DaemonRpcResponse =
  | { readonly id: string; readonly ok: true; readonly result: unknown }
  | {
      readonly id: string;
      readonly ok: false;
      readonly error: { readonly message: string; readonly name?: string };
    };
```

- [x] Run protocol tests and typecheck the daemon package path.

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/protocol.unit.test.ts
pnpm run typecheck
```

Expected GREEN: protocol tests pass; typecheck exits 0.

- [x] Commit.

```powershell
git add packages/ohbaby-agent/src/runtime/daemon/protocol.ts packages/ohbaby-agent/src/runtime/daemon/protocol.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/index.ts
git commit -m "feat(daemon): define explicit ui protocol"
```

## Task 3.2: Permission Routing

**Files:**

- Create: `packages/ohbaby-agent/src/runtime/daemon/permission-router.ts`
- Create: `packages/ohbaby-agent/src/runtime/daemon/permission-router.unit.test.ts`

- [x] Write failing tests for routing behavior.

Test cases:

- `trackPromptClient(clientA)` followed by `observeEvent(run.updated run_1)` maps `run_1` to `clientA`.
- `filterEventForClient(permission.requested run_1, clientA)` returns the event.
- `filterEventForClient(permission.requested run_1, clientB)` returns `null`.
- `filterSnapshotForClient(snapshotWithPermissionRun1, clientB)` removes that permission but keeps sessions, runs, messages, and permission state.
- `filterEventForClient(permission.resolved, clientB)` returns the event so passive stores can clear stale state if they ever observed it.

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/permission-router.unit.test.ts
```

Expected RED: fails because `permission-router.ts` does not exist.

- [x] Implement `PermissionRouter`.

Required public API:

```ts
export class PermissionRouter {
  trackPromptClient(clientId: string): () => void;
  observeEvent(event: UiEvent): void;
  filterEventForClient(event: UiEvent, clientId: string): UiEvent | null;
  filterSnapshotForClient(snapshot: UiSnapshot, clientId: string): UiSnapshot;
}
```

Implementation rules:

- While a prompt is active for a client, the first unmapped `run.updated` event claims `run.id` for that client.
- `permission.requested` is delivered only to the owner of `request.runId`.
- If a run has no owner, deliver the permission request to all clients to avoid deadlock.
- Snapshots remove permission requests whose `runId` belongs to a different client.
- No mutation of input events or snapshots.

- [x] Run focused tests.

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/permission-router.unit.test.ts
```

Expected GREEN: permission router tests pass.

- [x] Commit.

```powershell
git add packages/ohbaby-agent/src/runtime/daemon/permission-router.ts packages/ohbaby-agent/src/runtime/daemon/permission-router.unit.test.ts
git commit -m "feat(daemon): route permission prompts by client"
```

## Task 3.3: HTTP/SSE Daemon Server

**Files:**

- Create: `packages/ohbaby-agent/src/runtime/daemon/server.ts`
- Create: `packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/index.ts`

- [x] Write failing integration tests using a fake `UiBackendClient`.

Test cases:

- `GET /api/health` returns 200 JSON `{ ok: true }`.
- `POST /api/rpc` with method `getSnapshot` returns the fake snapshot.
- Invalid method returns a JSON-RPC failure response and HTTP 400.
- Two SSE clients connected to `GET /api/events?clientId=...` both receive a session event.
- Permission events are delivered only to the owning client according to `PermissionRouter`.
- Closing the daemon server unsubscribes backend event handlers and closes SSE responses.

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts --no-file-parallelism
```

Expected RED: fails because `server.ts` does not exist.

- [x] Implement `createDaemonHttpServer`.

Required public API:

```ts
export interface DaemonHttpServerOptions {
  readonly backend: UiBackendClient;
  readonly host?: string;
  readonly port?: number;
  readonly permissionRouter?: PermissionRouter;
}

export interface DaemonHttpServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDaemonHttpServer(
  options: DaemonHttpServerOptions,
): DaemonHttpServerHandle;
```

HTTP routes:

- `GET /api/health`
- `POST /api/rpc`
- `GET /api/events?clientId=<id>&lastEventId=<optional>`

Implementation rules:

- Use Node `http`, not a new framework dependency.
- Parse request bodies with a size limit of 1 MiB.
- For `submitPrompt`, call `permissionRouter.trackPromptClient(clientId)` before invoking backend and release it in `finally`.
- For `getSnapshot`, filter the result through `permissionRouter.filterSnapshotForClient`.
- SSE event format uses `event: ui.event` and JSON `data`.
- Send an initial `hello` event containing the client id.

- [x] Run focused tests.

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/protocol.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/permission-router.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts --no-file-parallelism
```

Expected GREEN: protocol, router, and server tests pass.

- [x] Commit.

```powershell
git add packages/ohbaby-agent/src/runtime/daemon/server.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts packages/ohbaby-agent/src/runtime/daemon/index.ts
git commit -m "feat(daemon): serve ui backend over http"
```

## Task 3.4: Remote Client

**Files:**

- Create: `packages/ohbaby-agent/src/runtime/daemon/client.ts`
- Create: `packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/index.ts`

- [ ] Write failing integration tests against `createDaemonHttpServer`.

Test cases:

- Remote client `getSnapshot` returns the server snapshot.
- Remote client `submitPrompt` sends text and options to the backend.
- Remote client `subscribeEvents` receives SSE `UiEvent` payloads.
- `unsubscribe` aborts the SSE fetch loop and no longer delivers events.
- RPC failure responses reject with the server error message.

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts --no-file-parallelism
```

Expected RED: fails because `client.ts` does not exist.

- [ ] Implement `createRemoteUiBackendClient` and `createRemoteCoreApiHost`.

Required public API:

```ts
export interface RemoteDaemonClientOptions {
  readonly host?: string;
  readonly port: number;
  readonly fetch?: typeof fetch;
  readonly clientId?: string;
}

export function createRemoteUiBackendClient(
  options: RemoteDaemonClientOptions,
): UiBackendClient & { dispose(): Promise<void> };

export function createRemoteCoreApiHost(
  options: RemoteDaemonClientOptions,
): CoreApiHost;
```

Implementation rules:

- Generate one stable `clientId` per remote client.
- Every CoreAPI method is a POST to `/api/rpc` with `[...args]` params.
- `subscribeEvents` lazily starts one SSE loop shared by local handlers.
- `dispose` aborts the SSE loop and clears handlers.
- The client does not reconnect automatically in Phase 3; reconnect behavior is covered by calling `getSnapshot` after a new client is created.

- [ ] Run focused tests.

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts --no-file-parallelism
```

Expected GREEN: client and server integration tests pass.

- [ ] Commit.

```powershell
git add packages/ohbaby-agent/src/runtime/daemon/client.ts packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts packages/ohbaby-agent/src/runtime/daemon/index.ts
git commit -m "feat(daemon): add remote ui client"
```

## Task 3.5: Serve Command And Core Host Wiring

**Files:**

- Create: `packages/ohbaby-agent/src/runtime/daemon/main.ts`
- Modify: `packages/ohbaby-agent/src/host/core-api-factory.ts`
- Modify: `packages/ohbaby-agent/src/index.ts`
- Modify: `packages/ohbaby-cli/src/cli/commands/types.ts`
- Modify: `packages/ohbaby-cli/src/cli/commands/terminal.ts`
- Modify: `packages/ohbaby-cli/src/cli/commands/serve.ts`
- Modify: `packages/ohbaby-cli/src/bin.ts`
- Test: `packages/ohbaby-cli/src/bin.unit.test.ts`
- Test: `packages/ohbaby-cli/src/cli/commands/serve.unit.test.ts`

- [ ] Write failing CLI tests.

Test cases:

- `ohbaby --remote-port 4096` passes `{ remotePort: 4096, remoteHost: "127.0.0.1" }` to `buildCoreAPIImpl`.
- `ohbaby --remote-port 4096 --resume session_1` preserves resume options.
- `ohbaby serve --port 4096` calls the daemon start helper and writes the listening URL.
- `ohbaby serve status` prints the current state file status.
- `ohbaby serve stop` sends SIGTERM to the recorded daemon pid or exits cleanly when no daemon is running.

Run:

```powershell
pnpm exec vitest run packages/ohbaby-cli/src/bin.unit.test.ts packages/ohbaby-cli/src/cli/commands/serve.unit.test.ts --no-file-parallelism
```

Expected RED: remote and serve tests fail because options and serve helper are missing.

- [ ] Implement daemon main helpers.

Required public API:

```ts
export interface StartDaemonServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly dbPath?: string;
}

export interface RunningDaemonServer {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

export function startDaemonServer(
  options?: StartDaemonServerOptions,
): Promise<RunningDaemonServer>;

export function readDaemonStatus(): Promise<DaemonState | undefined>;
export function stopDaemonFromState(): Promise<"stopped" | "not-running">;
```

Implementation rules:

- `startDaemonServer` creates one `createPersistentUiBackendClient` and one `createDaemonHttpServer`.
- `stop` closes HTTP server first, then disposes the backend.
- `serve` foreground process stays alive because the HTTP server is listening.
- `buildCoreAPIImpl` returns `createRemoteCoreApiHost` when `remotePort` is present.

- [ ] Implement CLI option parsing and serve command.

Options:

- Terminal: `--remote-port <number>`, `--remote-host <host>` default `127.0.0.1`.
- Serve: `ohbaby serve [start|status|stop]`, default action `start`.
- Serve start: `--port <number>` default `4096`, `--host <host>` default `127.0.0.1`, optional `--db-path <path>`.

- [ ] Run focused tests.

```powershell
pnpm exec vitest run packages/ohbaby-cli/src/bin.unit.test.ts packages/ohbaby-cli/src/cli/commands/serve.unit.test.ts --no-file-parallelism
pnpm run typecheck
```

Expected GREEN: CLI tests and typecheck pass.

- [ ] Commit.

```powershell
git add packages/ohbaby-agent/src/runtime/daemon/main.ts packages/ohbaby-agent/src/host/core-api-factory.ts packages/ohbaby-agent/src/index.ts packages/ohbaby-cli/src/cli/commands/types.ts packages/ohbaby-cli/src/cli/commands/terminal.ts packages/ohbaby-cli/src/cli/commands/serve.ts packages/ohbaby-cli/src/bin.ts packages/ohbaby-cli/src/bin.unit.test.ts packages/ohbaby-cli/src/cli/commands/serve.unit.test.ts
git commit -m "feat(cli): connect terminal to explicit daemon"
```

## Task 3.6: End-To-End Remote Terminal Flow

**Files:**

- Create: `tests/integration/cli/daemon-terminal.integration.test.ts`
- Modify: `docs/problem-lists/terminal-daemon/04-test-criteria.md`
- Modify: `docs/problem-lists/terminal-daemon/05-implementation-plan.md`
- Modify: `docs/problem-lists/terminal-daemon/07-phase-3-execution-plan.md`

- [ ] Write an integration test for explicit daemon + remote CLI.

Scenario:

1. Start daemon server with a temp DB and fake LLM client if available through existing test helpers.
2. Create a remote client against the daemon.
3. Submit a prompt.
4. Assert events include run/session/message updates.
5. Dispose the client.
6. Create a second remote client against the same daemon.
7. Assert `getSnapshot` returns the existing session history.

Run:

```powershell
pnpm exec vitest run tests/integration/cli/daemon-terminal.integration.test.ts --no-file-parallelism
```

Expected RED: test fails until the daemon start/client path is fully wired.

- [ ] Implement missing wiring exposed by the E2E test.

Allowed fixes:

- Add dependency injection hooks to `startDaemonServer` for tests.
- Export a test-only server factory only if it is under `runtime/daemon` and used by production code too.
- Do not make `pnpm start` default to daemon in Phase 3.

- [ ] Run Phase 3 focused verification.

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/protocol.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/permission-router.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts packages/ohbaby-cli/src/bin.unit.test.ts packages/ohbaby-cli/src/cli/commands/serve.unit.test.ts tests/integration/cli/daemon-terminal.integration.test.ts --no-file-parallelism
```

Expected GREEN: all Phase 3 focused tests pass.

- [ ] Update docs and commit.

```powershell
git add tests/integration/cli/daemon-terminal.integration.test.ts docs/problem-lists/terminal-daemon/04-test-criteria.md docs/problem-lists/terminal-daemon/05-implementation-plan.md docs/problem-lists/terminal-daemon/07-phase-3-execution-plan.md
git commit -m "test(cli): cover explicit daemon terminal flow"
```

## Phase 3 Verification

- [ ] Run narrow Phase 3 tests first:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/protocol.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/permission-router.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts packages/ohbaby-cli/src/bin.unit.test.ts packages/ohbaby-cli/src/cli/commands/serve.unit.test.ts tests/integration/cli/daemon-terminal.integration.test.ts --no-file-parallelism
```

- [ ] Run full phase gates:

```powershell
pnpm run typecheck
pnpm run lint
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm test:e2e:snapshot
pnpm test:smoke:real
pnpm run build
```

- [ ] Request subagent review focused on:

  - protocol compatibility with `CoreAPI`.
  - server lifecycle cleanup and dangling SSE connections.
  - permission routing and observer-client behavior.
  - accidental Phase 4 scope creep.
  - Windows localhost reliability.

- [ ] Fix review findings with tests.
- [ ] Commit final fixes.
- [ ] Stop with branch `feat/terminal-daemon-phase-3` unmerged for user review.

## Self-Review

Spec coverage:

- P6 daemon production entry is covered by Tasks 3.3 and 3.5.
- P8 remote communication infrastructure is covered by Tasks 3.1, 3.3, and 3.4.
- Remote terminal behavior is covered by Tasks 3.4 and 3.6.
- Permission routing is covered by Task 3.2 and server integration tests.
- Auto-spawn and global FIFO are explicitly excluded and remain Phase 4.

Placeholder scan:

- This plan has exact files, commands, and expected RED/GREEN outcomes.
- No unresolved placeholder markers are left.

Type consistency:

- Protocol method names match `CoreAPI`.
- Remote host factory returns the same `CoreApiHost` shape used by `buildCoreAPIImpl`.
- Permission routing uses existing `UiEvent` and `UiSnapshot` types without introducing new TUI event variants.
