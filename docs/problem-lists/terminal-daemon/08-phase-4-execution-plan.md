# Phase 4 Auto-Spawn Daemon And Global FIFO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make normal terminal startup daemon-backed by default, with deterministic daemon discovery, authenticated local RPC, per-client startup intent, daemon-owned same-session FIFO, version handoff, idle self-exit, and explicit in-process fallback.

**Architecture:** Phase 4 keeps the Phase 3 HTTP/SSE protocol, but moves production coordination into the daemon. Clients discover or spawn one local daemon, authenticate with a state-file token, send startup intent as client-scoped RPC state, and submit prompts through a daemon-owned queue. The persistent backend remains the storage/runtime implementation; the daemon server becomes the single writer and the only prompt-ordering authority for daemon mode.

**Tech Stack:** TypeScript, Node.js `http`, Node.js detached child processes, `fetch`, Server-Sent Events, Vitest, yargs, existing `UiBackendClient`, existing persistent backend, existing Ink TUI.

---

## Scope Boundary

Implement Phase 4 from `05-implementation-plan.md` Tasks 4.1-4.6.

Do not add ACP or A2A infrastructure. The supported remote surface remains the existing HTTP JSON-RPC plus SSE daemon protocol. Web/App clients can reuse that surface later; ACP/A2A stay adapter-layer work after product requirements exist.

---

## File Structure

Create:

- `packages/ohbaby-agent/src/runtime/daemon/spawn.ts` - client-side daemon discovery, stale-state cleanup, version check, spawn, and ready polling.
- `packages/ohbaby-agent/src/runtime/daemon/spawn.unit.test.ts` - auto-spawn, reuse, stale pid, bind failure, version handoff, and concurrent spawn tests using injected process/fetch/state dependencies.
- `packages/ohbaby-agent/src/runtime/daemon/auth.ts` - local bearer token helpers used by state file, server, and client.
- `packages/ohbaby-agent/src/runtime/daemon/auth.unit.test.ts` - token creation, redaction, and auth header validation tests.
- `packages/ohbaby-agent/src/runtime/daemon/prompt-queue.ts` - daemon-owned prompt FIFO with per-session active state, owner tracking, abort drain, shutdown rejection, and busy retry.
- `packages/ohbaby-agent/src/runtime/daemon/prompt-queue.unit.test.ts` - ordering, interrupt, disconnect, shutdown, and busy retry tests.
- `tests/integration/cli/daemon-global-fifo.integration.test.ts` - two remote clients against one daemon, same session FIFO, interrupt drains next queued prompt.
- `tests/integration/cli/daemon-auto-spawn.integration.test.ts` - CLI-level default daemon discovery/spawn/reuse and in-process escape hatch.

Modify:

- `packages/ohbaby-agent/src/runtime/daemon/types.ts` - extend `DaemonState` with connection metadata, package version, auth token metadata, and optional idle metadata.
- `packages/ohbaby-agent/src/runtime/daemon/state-file.ts` - parse/write the extended state shape and ignore invalid/incomplete running records.
- `packages/ohbaby-agent/src/runtime/daemon/supervisor.ts` - write running state after server binds, expose runtime connection metadata, handle graceful retirement, and support idle stop scheduling.
- `packages/ohbaby-agent/src/runtime/daemon/server.ts` - require auth when configured, add health/version response, client lifecycle callbacks, startup-intent RPC, shutdown/retire RPC, and prompt queue wiring.
- `packages/ohbaby-agent/src/runtime/daemon/client.ts` - send auth headers, expose connection status events to consumers, send per-client startup intent, and surface SSE disconnects.
- `packages/ohbaby-agent/src/runtime/daemon/main.ts` - pass version/auth/state metadata to supervisor/server, expose daemon serve entry for detached spawn, and support controlled shutdown from RPC.
- `packages/ohbaby-agent/src/runtime/daemon/index.ts` - export new spawn, auth, prompt queue types.
- `packages/ohbaby-agent/src/host/core-api-factory.ts` - choose auto-spawned remote daemon by default, preserve explicit remote and in-process fallback modes, and pass startup intent to remote clients.
- `packages/ohbaby-agent/src/adapters/ui-persistent.ts` - add an explicit `backendLeaseMode` option so daemon mode can bypass the Phase 1 lease while `--in-process` retains it.
- `packages/ohbaby-cli/src/cli/commands/types.ts` - add `daemon?: boolean`, `inProcess?: boolean`, and daemon discovery dependency types for tests.
- `packages/ohbaby-cli/src/cli/commands/terminal.ts` - add `--in-process` and `--no-daemon`, default to daemon-backed host creation, and keep explicit `--remote-port` path for developer use.
- `packages/ohbaby-cli/src/bin.ts` - wire default options and injected daemon helpers through runtime construction.
- `packages/ohbaby-cli/src/bin.unit.test.ts` - update startup mode expectations.
- `packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts` - cover default daemon, explicit remote, startup intent, and in-process fallback.
- `docs/problem-lists/terminal-daemon/02-solution-design.md` - record final backend lease decision.
- `docs/problem-lists/terminal-daemon/04-test-criteria.md` - mark Phase 4 auto-spawn and FIFO criteria as covered.
- `docs/problem-lists/terminal-daemon/05-implementation-plan.md` - check off Phase 4 tasks as they land.
- `docs/problem-lists/terminal-daemon/08-phase-4-execution-plan.md` - update checkboxes after each task.

---

## Task 4A: State Metadata, Auth, And Auto-Spawn Discovery

**Files:**

- Create: `packages/ohbaby-agent/src/runtime/daemon/auth.ts`
- Create: `packages/ohbaby-agent/src/runtime/daemon/auth.unit.test.ts`
- Create: `packages/ohbaby-agent/src/runtime/daemon/spawn.ts`
- Create: `packages/ohbaby-agent/src/runtime/daemon/spawn.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/types.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/state-file.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/supervisor.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/server.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/client.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/main.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/index.ts`

- [x] **Step 1: Write auth unit tests**

Add `auth.unit.test.ts` with these cases:

```ts
import { describe, expect, it } from "vitest";
import {
  createDaemonAuthToken,
  daemonAuthHeader,
  isAuthorizedDaemonRequest,
  redactDaemonAuthToken,
} from "./auth.js";

describe("daemon auth", () => {
  it("creates a non-empty local bearer token", () => {
    expect(createDaemonAuthToken()).toMatch(/^ohbaby_[a-f0-9-]{36}$/);
  });

  it("formats bearer auth headers", () => {
    expect(daemonAuthHeader("token_1")).toBe("Bearer token_1");
  });

  it("accepts only the configured daemon token", () => {
    expect(isAuthorizedDaemonRequest("Bearer token_1", "token_1")).toBe(true);
    expect(isAuthorizedDaemonRequest("Bearer token_2", "token_1")).toBe(false);
    expect(isAuthorizedDaemonRequest(undefined, "token_1")).toBe(false);
  });

  it("redacts tokens before logging", () => {
    expect(redactDaemonAuthToken("ohbaby_1234567890")).toBe("ohbaby_...");
  });
});
```

- [x] **Step 2: Run auth tests and verify RED**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/auth.unit.test.ts
```

Expected: FAIL because `auth.ts` does not exist.

- [x] **Step 3: Implement auth helpers**

Add `auth.ts`:

```ts
import { randomUUID } from "node:crypto";

const TOKEN_PREFIX = "ohbaby_";

export function createDaemonAuthToken(): string {
  return `${TOKEN_PREFIX}${randomUUID()}`;
}

export function daemonAuthHeader(token: string): string {
  return `Bearer ${token}`;
}

export function isAuthorizedDaemonRequest(
  authorization: string | undefined,
  token: string | undefined,
): boolean {
  if (!token) {
    return true;
  }
  return authorization === daemonAuthHeader(token);
}

export function redactDaemonAuthToken(token: string | undefined): string {
  if (!token) {
    return "";
  }
  return token.startsWith(TOKEN_PREFIX) ? `${TOKEN_PREFIX}...` : "...";
}
```

- [x] **Step 4: Extend daemon state tests**

Add cases to `state-file.unit.test.ts`:

```ts
it("round-trips running connection metadata", async () => {
  const file = new JsonDaemonStateFile(path.join(dir, "daemon-state.json"));
  await file.write({
    authToken: "token_1",
    host: "127.0.0.1",
    packageVersion: "0.1.0",
    pid: 123,
    port: 4096,
    startedAt: 1_000,
    status: "running",
    updatedAt: 1_001,
  });

  await expect(file.read()).resolves.toEqual({
    authToken: "token_1",
    host: "127.0.0.1",
    packageVersion: "0.1.0",
    pid: 123,
    port: 4096,
    startedAt: 1_000,
    status: "running",
    updatedAt: 1_001,
  });
});

it("ignores running state without connection metadata", async () => {
  await fs.writeFile(
    path.join(dir, "daemon-state.json"),
    JSON.stringify({ pid: 123, status: "running", updatedAt: 1_001 }),
    "utf8",
  );

  await expect(new JsonDaemonStateFile(path.join(dir, "daemon-state.json")).read())
    .resolves.toBeUndefined();
});
```

- [x] **Step 5: Run state/auth tests and verify RED**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/auth.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/state-file.unit.test.ts
```

Expected: auth passes; state metadata test fails until `DaemonState` and parser are extended.

- [x] **Step 6: Extend `DaemonState` and parser**

Update `types.ts`:

```ts
export interface DaemonState {
  readonly status: DaemonStatus;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly updatedAt: number;
  readonly error?: string;
  readonly host?: string;
  readonly port?: number;
  readonly packageVersion?: string;
  readonly authToken?: string;
  readonly idleSince?: number;
}
```

Update `state-file.ts` parser so `running` states require `pid`, `host`, `port`, `packageVersion`, and `authToken`; `stopping`, `stopped`, and `crashed` keep accepting lifecycle-only state.

- [x] **Step 7: Write spawn unit tests**

Create `spawn.unit.test.ts` with injected dependencies:

```ts
import { describe, expect, it, vi } from "vitest";
import { ensureDaemonRunning } from "./spawn.js";
import type { DaemonStateFile } from "./types.js";

class MemoryStateFile implements DaemonStateFile {
  constructor(private state: Awaited<ReturnType<DaemonStateFile["read"]>>) {}
  read = vi.fn(async () => this.state);
  write = vi.fn(async (state) => {
    this.state = state;
  });
}

describe("ensureDaemonRunning", () => {
  it("reuses a healthy matching daemon", async () => {
    const stateFile = new MemoryStateFile({
      authToken: "token_1",
      host: "127.0.0.1",
      packageVersion: "0.1.0",
      pid: 123,
      port: 4096,
      startedAt: 1,
      status: "running",
      updatedAt: 2,
    });
    const spawn = vi.fn();

    await expect(
      ensureDaemonRunning({
        currentVersion: "0.1.0",
        fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
        isProcessAlive: () => true,
        spawn,
        stateFile,
      }),
    ).resolves.toMatchObject({ authToken: "token_1", port: 4096 });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns when no running daemon is recorded", async () => {
    const stateFile = new MemoryStateFile(undefined);
    const spawn = vi.fn(async () => undefined);

    await ensureDaemonRunning({
      currentVersion: "0.1.0",
      fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
      isProcessAlive: () => true,
      pollIntervalMs: 0,
      spawn,
      stateFile,
      waitForState: async () => ({
        authToken: "token_2",
        host: "127.0.0.1",
        packageVersion: "0.1.0",
        pid: 124,
        port: 4097,
        startedAt: 3,
        status: "running",
        updatedAt: 4,
      }),
    });

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("retires a version-mismatched daemon before spawning", async () => {
    const stateFile = new MemoryStateFile({
      authToken: "old_token",
      host: "127.0.0.1",
      packageVersion: "0.0.9",
      pid: 123,
      port: 4096,
      startedAt: 1,
      status: "running",
      updatedAt: 2,
    });
    const calls: string[] = [];

    await ensureDaemonRunning({
      currentVersion: "0.1.0",
      fetch: vi.fn(async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
      isProcessAlive: () => true,
      pollIntervalMs: 0,
      spawn: vi.fn(async () => {
        calls.push("spawn");
      }),
      stateFile,
      waitForState: async () => ({
        authToken: "new_token",
        host: "127.0.0.1",
        packageVersion: "0.1.0",
        pid: 124,
        port: 4097,
        startedAt: 3,
        status: "running",
        updatedAt: 4,
      }),
    });

    expect(calls).toEqual([
      "http://127.0.0.1:4096/api/shutdown",
      "spawn",
    ]);
  });
});
```

- [x] **Step 8: Run spawn tests and verify RED**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/spawn.unit.test.ts
```

Expected: FAIL because `spawn.ts` does not exist.

- [x] **Step 9: Implement `ensureDaemonRunning`**

Implement `spawn.ts` with this public interface:

```ts
export interface RunningDaemonConnection {
  readonly host: string;
  readonly port: number;
  readonly authToken: string;
  readonly packageVersion: string;
}

export interface EnsureDaemonRunningOptions {
  readonly currentVersion: string;
  readonly stateFile?: DaemonStateFile;
  readonly stateFilePath?: string;
  readonly fetch?: typeof fetch;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly spawn?: () => Promise<void>;
  readonly waitForState?: () => Promise<DaemonState>;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}
```

Implementation rules:

- Read state-file first.
- If running state exists, pid is alive, health endpoint succeeds, and `packageVersion === currentVersion`, return its connection metadata.
- If version differs, POST `/api/shutdown` with bearer token, wait for a new matching state.
- If state is missing, invalid, stale, or health fails, call `spawn`.
- If concurrent spawn loses the PID lock, the spawned process exits and the client still polls state; the caller sees a connection, not a failure.
- Timeout message must include `daemon did not become ready`.

- [x] **Step 10: Wire auth and metadata into server/main/supervisor/client**

Make these concrete changes:

- `createDaemonHttpServer({ authToken })` checks bearer auth on `/api/rpc`, `/api/events`, and `/api/shutdown`.
- `/api/health` returns `{ ok: true, packageVersion }`.
- `RemoteDaemonClientOptions` gains `authToken?: string`; RPC and SSE requests send `authorization`.
- `StartDaemonServerOptions` gains `packageVersion?: string`, `authToken?: string`, and `idleTimeoutMs?: number`.
- `Supervisor` writes running state after the server has bound, using runtime metadata from `DaemonRuntimeHandle`:

```ts
export interface DaemonRuntimeHandle {
  readonly connection?: {
    readonly host: string;
    readonly port: number;
    readonly authToken?: string;
    readonly packageVersion?: string;
  };
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

- [x] **Step 11: Run 4A focused verification**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/auth.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/state-file.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/spawn.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/supervisor.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts packages/ohbaby-agent/src/runtime/daemon/main.unit.test.ts --no-file-parallelism
pnpm run typecheck
```

Expected: all listed tests pass, typecheck passes.

- [x] **Step 12: Commit 4A**

```powershell
git add packages/ohbaby-agent/src/runtime/daemon/auth.ts packages/ohbaby-agent/src/runtime/daemon/auth.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/spawn.ts packages/ohbaby-agent/src/runtime/daemon/spawn.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/types.ts packages/ohbaby-agent/src/runtime/daemon/state-file.ts packages/ohbaby-agent/src/runtime/daemon/supervisor.ts packages/ohbaby-agent/src/runtime/daemon/server.ts packages/ohbaby-agent/src/runtime/daemon/client.ts packages/ohbaby-agent/src/runtime/daemon/main.ts packages/ohbaby-agent/src/runtime/daemon/index.ts
git commit -m "feat(daemon): discover and authenticate local daemon"
```

---

## Task 4B: Daemon Global FIFO Queue

**Files:**

- Create: `packages/ohbaby-agent/src/runtime/daemon/prompt-queue.ts`
- Create: `packages/ohbaby-agent/src/runtime/daemon/prompt-queue.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/server.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/index.ts`

- [x] **Step 1: Write prompt queue unit tests**

Create tests covering this exact behavior:

```ts
it("runs same-session prompts in submit order", async () => {
  const calls: string[] = [];
  const gates = createDeferredGates(2);
  const queue = new DaemonPromptQueue({
    submit: async (item) => {
      calls.push(item.text);
      await gates.shift()!.promise;
    },
  });

  const first = queue.enqueue({ clientId: "a", sessionId: "s1", text: "A" });
  const second = queue.enqueue({ clientId: "b", sessionId: "s1", text: "B" });

  await vi.waitUntil(() => calls.length === 1);
  expect(calls).toEqual(["A"]);
  gates[0].resolve();
  await first;
  await vi.waitUntil(() => calls.length === 2);
  expect(calls).toEqual(["A", "B"]);
  gates[1].resolve();
  await second;
});

it("runs different sessions concurrently", async () => {
  const active = new Set<string>();
  const seen: string[] = [];
  const queue = new DaemonPromptQueue({
    submit: async (item) => {
      active.add(item.sessionId ?? "__fresh__");
      seen.push(`${item.text}:${String(active.size)}`);
      await Promise.resolve();
      active.delete(item.sessionId ?? "__fresh__");
    },
  });

  await Promise.all([
    queue.enqueue({ clientId: "a", sessionId: "s1", text: "A" }),
    queue.enqueue({ clientId: "b", sessionId: "s2", text: "B" }),
  ]);

  expect(seen).toContain("A:1");
  expect(seen).toContain("B:2");
});

it("drains the next same-session prompt after active abort settles", async () => {
  const calls: string[] = [];
  const firstGate = deferred<void>();
  const queue = new DaemonPromptQueue({
    submit: async (item) => {
      calls.push(item.text);
      if (item.text === "A") {
        await firstGate.promise;
      }
    },
  });

  const first = queue.enqueue({ clientId: "a", sessionId: "s1", text: "A" });
  const second = queue.enqueue({ clientId: "b", sessionId: "s1", text: "B" });
  await vi.waitUntil(() => calls.length === 1);
  firstGate.resolve();
  await first;
  await second;
  expect(calls).toEqual(["A", "B"]);
});

it("does not cancel accepted prompts when a client disconnects", async () => {
  const calls: string[] = [];
  const queue = new DaemonPromptQueue({
    submit: async (item) => {
      calls.push(`${item.clientId}:${item.text}`);
    },
  });

  const accepted = queue.enqueue({ clientId: "a", sessionId: "s1", text: "A" });
  queue.disconnectClient("a");
  await accepted;
  expect(calls).toEqual(["a:A"]);
});

it("rejects accepted but unstarted prompts on shutdown", async () => {
  const gate = deferred<void>();
  const queue = new DaemonPromptQueue({
    submit: async () => gate.promise,
  });

  const first = queue.enqueue({ clientId: "a", sessionId: "s1", text: "A" });
  const second = queue.enqueue({ clientId: "b", sessionId: "s1", text: "B" });
  await vi.waitUntil(() => queue.size === 1);
  queue.shutdown("daemon stopped");
  await expect(second).rejects.toThrow("daemon stopped");
  gate.resolve();
  await first;
});
```

- [x] **Step 2: Run queue tests and verify RED**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/prompt-queue.unit.test.ts
```

Expected: FAIL because `prompt-queue.ts` does not exist.

- [x] **Step 3: Implement `DaemonPromptQueue`**

Implement this public API:

```ts
export interface DaemonPromptQueueItem {
  readonly clientId: string;
  readonly sessionId?: string;
  readonly text: string;
  readonly options?: SubmitPromptOptions;
}

export interface DaemonPromptQueueOptions {
  readonly submit: (item: DaemonPromptQueueItem) => Promise<void>;
  readonly isBusyError?: (error: unknown) => boolean;
  readonly retryDelayMs?: number;
}

export class DaemonPromptQueue {
  get size(): number;
  enqueue(item: DaemonPromptQueueItem): Promise<void>;
  disconnectClient(clientId: string): void;
  shutdown(reason: string): void;
}
```

Rules:

- Same `sessionId` has one active item at a time.
- Missing `sessionId` is treated as a fresh-session lane and is serialized so two fresh prompts do not reuse the same empty startup view.
- Different concrete session IDs may run concurrently.
- Busy errors are retried inside the queue with bounded exponential backoff from 250ms to 2000ms.
- `shutdown` rejects only unstarted queued items and lets active items settle.

- [x] **Step 4: Wire `server.submitPrompt` through the queue**

Change `createDaemonHttpServer` so it constructs one `DaemonPromptQueue` by default:

```ts
const promptQueue = options.promptQueue ?? new DaemonPromptQueue({
  isBusyError: isSessionRunBusyError,
  submit: async (item) => {
    const release = permissionRouter.trackPromptClient(item.clientId, item.sessionId);
    try {
      await backend.submitPrompt(item.text, item.options);
    } finally {
      release();
    }
  },
});
```

`callBackend` for `submitPrompt` calls:

```ts
return promptQueue.enqueue({
  clientId: request.clientId,
  options,
  sessionId: options?.sessionId,
  text: request.params[0] as string,
});
```

- [x] **Step 5: Add server integration coverage**

Add to `server.integration.test.ts`:

```ts
it("queues same-session prompt submissions across clients", async () => {
  const backend = new FakeBackend();
  backend.holdSubmits = true;
  await withServer(backend, async (url) => {
    const first = postRpc(url, {
      clientId: "client_a",
      id: "rpc_first",
      method: "submitPrompt",
      params: ["first", { sessionId: "session_1" }],
    });
    const second = postRpc(url, {
      clientId: "client_b",
      id: "rpc_second",
      method: "submitPrompt",
      params: ["second", { sessionId: "session_1" }],
    });

    await vi.waitUntil(() => backend.submitted.length === 1);
    expect(backend.submitted).toEqual([
      { options: { sessionId: "session_1" }, text: "first" },
    ]);

    backend.resolveHeldSubmits();
    await first;
    await vi.waitUntil(() => backend.submitted.length === 2);
    expect(backend.submitted[1]).toEqual({
      options: { sessionId: "session_1" },
      text: "second",
    });
    backend.resolveHeldSubmits();
    await second;
  });
});
```

- [x] **Step 6: Run 4B focused verification**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/prompt-queue.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts --no-file-parallelism
pnpm run typecheck
```

Expected: queue and server tests pass, typecheck passes.

- [x] **Step 7: Commit 4B**

```powershell
git add packages/ohbaby-agent/src/runtime/daemon/prompt-queue.ts packages/ohbaby-agent/src/runtime/daemon/prompt-queue.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/server.ts packages/ohbaby-agent/src/runtime/daemon/index.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts
git commit -m "feat(daemon): queue prompts globally"
```

---

## Task 4C: Default Terminal Uses Daemon And Startup Intent

**Files:**

- Modify: `packages/ohbaby-agent/src/runtime/daemon/protocol.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/server.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/client.ts`
- Modify: `packages/ohbaby-agent/src/host/core-api-factory.ts`
- Modify: `packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts`
- Modify: `packages/ohbaby-cli/src/cli/commands/types.ts`
- Modify: `packages/ohbaby-cli/src/cli/commands/terminal.ts`
- Modify: `packages/ohbaby-cli/src/bin.ts`
- Modify: `packages/ohbaby-cli/src/bin.unit.test.ts`
- Create: `tests/integration/cli/daemon-auto-spawn.integration.test.ts`

- [x] **Step 1: Add startup intent to protocol tests**

Extend protocol method list tests so `initializeClient` is a valid RPC method:

```ts
expect(DAEMON_RPC_METHODS).toContain("initializeClient");
expect(createDaemonRpcRequest({
  clientId: "client_1",
  id: "rpc_init",
  method: "initializeClient",
  params: [{ startupSessionMode: { type: "continue" } }],
})).toMatchObject({ method: "initializeClient" });
```

- [x] **Step 2: Add remote client startup tests**

In `client.integration.test.ts`, assert a client with startup intent calls `initializeClient` before first snapshot:

```ts
const client = createRemoteUiBackendClient({
  clientId: "client_a",
  fetch: fetchImpl,
  port,
  startupIntent: { resumeSessionId: "session_1" },
});
await client.getSnapshot();
expect(backend.initializedClients).toEqual([
  { clientId: "client_a", resumeSessionId: "session_1" },
]);
```

- [x] **Step 3: Implement startup intent RPC**

Add:

```ts
export interface DaemonStartupIntent {
  readonly startupSessionMode?: { readonly type: "continue" };
  readonly resumeSessionId?: string;
  readonly initialPermission?: {
    readonly level: "default" | "full-access";
    readonly mode: "plan" | "auto";
  };
}
```

Server behavior:

- `initializeClient` stores intent by `clientId`.
- For `resumeSessionId`, server validates the session exists in `backend.getSnapshot().sessions`, then records a client-local `activeSessionId` override.
- For `continue`, server resolves the newest non-subagent session from `backend.getSnapshot().sessions`, then records that id as the same client-local override.
- For fresh startup, server records `activeSessionId: null` for that client and does not create an empty session.
- `getSnapshot` returns a cloned snapshot with the requesting client's `activeSessionId` and initial permission/mode overlay; it never writes startup intent into the daemon backend's global store.
- `submitPrompt` without an explicit `sessionId` uses the requesting client's `activeSessionId` when present; if the client-local id is `null`, the backend creates the first session on first prompt.

- [x] **Step 4: Add core factory tests**

Update `core-api-factory.unit.test.ts`:

```ts
it("uses auto-spawned daemon by default", async () => {
  const ensureDaemonRunning = vi.fn(async () => ({
    authToken: "token_1",
    host: "127.0.0.1",
    packageVersion: "0.1.0",
    port: 4096,
  }));
  const createRemoteCoreApiHost = vi.fn(() => remoteHost);

  const { buildCoreAPIImpl } = await import("./core-api-factory.js");
  const api = await buildCoreAPIImpl({ ensureDaemonRunning });

  expect(api).toBe(remoteHost);
  expect(createRemoteCoreApiHost).toHaveBeenCalledWith(expect.objectContaining({
    authToken: "token_1",
    port: 4096,
  }));
});

it("keeps in-process fallback explicit", async () => {
  buildCoreAPIImpl({ inProcess: true });
  expect(createPersistentUiBackendClient).toHaveBeenCalled();
});
```

- [x] **Step 5: Change `buildCoreAPIImpl` to async for daemon discovery**

Update call sites so `runtime.createCoreHost` returns `Promise<CliCoreHost> | CliCoreHost`, and `terminal.ts` awaits it:

```ts
const host = await runtime.createCoreHost({
  daemon: args.inProcess === true || args.noDaemon === true ? false : true,
  inProcess: args.inProcess === true || args.noDaemon === true,
  startupIntent,
});
```

Preserve existing explicit remote path:

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

- [x] **Step 6: Add CLI flag tests**

Update `bin.unit.test.ts`:

```ts
it("defaults terminal startup to daemon mode", async () => {
  await runCli(["node", "ohbaby"], runtime);
  expect(createCoreHost).toHaveBeenCalledWith({ daemon: true });
});

it("uses in-process mode when --in-process is provided", async () => {
  await runCli(["node", "ohbaby", "--in-process"], runtime);
  expect(createCoreHost).toHaveBeenCalledWith({ daemon: false, inProcess: true });
});

it("keeps --no-daemon as an alias for in-process mode", async () => {
  await runCli(["node", "ohbaby", "--no-daemon"], runtime);
  expect(createCoreHost).toHaveBeenCalledWith({ daemon: false, inProcess: true });
});
```

- [x] **Step 7: Add auto-spawn integration test**

Create `daemon-auto-spawn.integration.test.ts`:

```ts
describe("daemon auto-spawn terminal flow", () => {
  it("starts one daemon for two default terminal clients", async () => {
    const home = await tempDirectory("ohbaby-daemon-auto-spawn-");
    const spawned: string[] = [];
    const first = await buildCoreAPIImpl({
      daemon: true,
      spawnDaemon: async () => {
        spawned.push("spawn");
        await startDaemonServer({ dbPath: path.join(home, "ui.db"), port: 0 });
      },
    });
    const second = await buildCoreAPIImpl({ daemon: true });

    expect(spawned).toEqual(["spawn"]);
    await first.dispose();
    await second.dispose();
  });
});
```

- [x] **Step 8: Run 4C focused verification**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/protocol.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/client.integration.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts packages/ohbaby-cli/src/bin.unit.test.ts tests/integration/cli/daemon-auto-spawn.integration.test.ts --no-file-parallelism
pnpm run typecheck
```

Expected: startup intent, CLI default daemon mode, explicit remote mode, and in-process fallback pass.

- [x] **Step 9: Commit 4C**

```powershell
git add packages/ohbaby-agent/src/runtime/daemon/protocol.ts packages/ohbaby-agent/src/runtime/daemon/server.ts packages/ohbaby-agent/src/runtime/daemon/client.ts packages/ohbaby-agent/src/host/core-api-factory.ts packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts packages/ohbaby-cli/src/cli/commands/types.ts packages/ohbaby-cli/src/cli/commands/terminal.ts packages/ohbaby-cli/src/bin.ts packages/ohbaby-cli/src/bin.unit.test.ts tests/integration/cli/daemon-auto-spawn.integration.test.ts
git commit -m "feat(cli): start terminal through daemon by default"
```

---

## Task 4D: Lifecycle Hardening, Lease Decision, And E2E FIFO

**Files:**

- Modify: `packages/ohbaby-agent/src/runtime/daemon/supervisor.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/server.ts`
- Modify: `packages/ohbaby-agent/src/runtime/daemon/spawn.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-persistent.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts`
- Create: `tests/integration/cli/daemon-global-fifo.integration.test.ts`
- Modify: `docs/problem-lists/terminal-daemon/02-solution-design.md`
- Modify: `docs/problem-lists/terminal-daemon/04-test-criteria.md`
- Modify: `docs/problem-lists/terminal-daemon/05-implementation-plan.md`
- Modify: `docs/problem-lists/terminal-daemon/08-phase-4-execution-plan.md`

- [ ] **Step 1: Add idle exit tests**

In `supervisor.unit.test.ts`:

```ts
it("stops after the idle timeout when the last client disconnects", async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const supervisor = new Supervisor({
    bootstrap: () => new RecordingRuntime(calls),
    idleTimeoutMs: 15 * 60 * 1000,
    logger: silentLogger,
    pidFile: new RecordingPidFile(calls),
    signalTarget: null,
    stateFile: new RecordingStateFile(calls),
  });

  await supervisor.start();
  supervisor.clientConnected("client_a");
  supervisor.clientDisconnected("client_a");
  await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

  expect(calls).toContain("runtime.stop");
  vi.useRealTimers();
});
```

- [ ] **Step 2: Implement idle client tracking**

Add methods:

```ts
clientConnected(clientId: string): void;
clientDisconnected(clientId: string): void;
retire(reason: string): Promise<void>;
```

Server calls these from SSE connection open/close. RPC-only clients call `clientConnected` on first authorized request and `clientDisconnected` from `disposeClient` if a dispose RPC exists; otherwise idle timeout remains conservative for SSE-backed terminal clients.

- [ ] **Step 3: Add backend lease tests**

In `ui-persistent.integration.test.ts`, prove daemon mode bypasses stale lease:

```ts
it("does not let a stale backend lease block daemon-mode prompt submission", async () => {
  seedBackendLease(db, {
    ownerId: "dead_backend",
    pid: 999999,
    state: "preparing",
    updatedAt: Date.now() - 60_000,
  });

  const client = createPersistentUiBackendClient({
    backendLeaseMode: "disabled",
    dbPath,
    llmClient: fakeLlm,
  });

  await expect(client.submitPrompt("hello", { sessionId: "session_1" }))
    .resolves.toBeUndefined();
});

it("keeps backend lease protection for in-process mode", async () => {
  const client = createPersistentUiBackendClient({
    backendLeaseMode: "enabled",
    dbPath,
    llmClient: fakeLlm,
  });

  await expect(client.submitPrompt("hello", { sessionId: "session_1" }))
    .resolves.toBeUndefined();
});
```

- [ ] **Step 4: Implement `backendLeaseMode`**

Add option:

```ts
readonly backendLeaseMode?: "enabled" | "disabled";
```

Default is `"enabled"` for direct persistent backend construction. `startDaemonServer` passes `"disabled"`. `buildCoreAPIImpl({ inProcess: true })` does not override the default.

- [ ] **Step 5: Add global FIFO E2E**

Create `daemon-global-fifo.integration.test.ts`:

```ts
describe("daemon global FIFO", () => {
  it("orders same-session prompts across remote clients and drains after abort", async () => {
    const home = await tempDirectory("ohbaby-daemon-fifo-");
    const server = await startDaemonServer({
      dbPath: path.join(home, "ui.db"),
      llmClient: createBlockingFakeLlm(),
      port: 0,
    });
    const clientA = createRemoteUiBackendClient({
      clientId: "terminal_a",
      port: server.port,
    });
    const clientB = createRemoteUiBackendClient({
      clientId: "terminal_b",
      port: server.port,
    });

    const first = clientA.submitPrompt("first", { sessionId: "session_1" });
    const second = clientB.submitPrompt("second", { sessionId: "session_1" });
    await waitForRunStarted("first");
    await clientA.abortRun();
    await first.catch(() => undefined);
    await second;
    expect(runOrder()).toEqual(["first", "second"]);

    await clientA.dispose();
    await clientB.dispose();
    await server.stop();
  });
});
```

- [ ] **Step 6: Update docs**

Update:

- `02-solution-design.md` section 3.5: daemon mode disables `persistentUiBackendLease`; in-process fallback keeps it.
- `04-test-criteria.md` Phase 4 preview: mark auto-spawn, reuse, zombie recovery, idle self-exit, `--no-daemon`, and permission owner routing according to implemented test evidence.
- `05-implementation-plan.md` Phase 4: check off completed tasks and add exact test commands run.
- `08-phase-4-execution-plan.md`: check boxes completed by this task.

- [ ] **Step 7: Run 4D focused verification**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/runtime/daemon/supervisor.unit.test.ts packages/ohbaby-agent/src/runtime/daemon/spawn.unit.test.ts packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts packages/ohbaby-agent/src/runtime/daemon/server.integration.test.ts tests/integration/cli/daemon-global-fifo.integration.test.ts --no-file-parallelism
pnpm run typecheck
```

Expected: lifecycle, lease, server, and FIFO E2E tests pass.

- [ ] **Step 8: Commit 4D**

```powershell
git add packages/ohbaby-agent/src/runtime/daemon/supervisor.ts packages/ohbaby-agent/src/runtime/daemon/server.ts packages/ohbaby-agent/src/runtime/daemon/spawn.ts packages/ohbaby-agent/src/adapters/ui-persistent.ts packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts tests/integration/cli/daemon-global-fifo.integration.test.ts docs/problem-lists/terminal-daemon/02-solution-design.md docs/problem-lists/terminal-daemon/04-test-criteria.md docs/problem-lists/terminal-daemon/05-implementation-plan.md docs/problem-lists/terminal-daemon/08-phase-4-execution-plan.md
git commit -m "fix(daemon): harden lifecycle and lease boundaries"
```

---

## Phase 4 Final Verification

- [ ] Run all unit tests:

```powershell
pnpm run test:unit
```

- [ ] Run all contract tests:

```powershell
pnpm run test:contract
```

- [ ] Run all integration tests:

```powershell
pnpm run test:integration
```

- [ ] Run E2E snapshot tests:

```powershell
pnpm run test:e2e:snapshot
```

- [ ] Run real `.env` smoke tests:

```powershell
pnpm run test:smoke:real
```

- [ ] Run lint, typecheck, and build:

```powershell
pnpm run lint
pnpm run typecheck
pnpm run build
```

- [ ] Run manual two-terminal daemon check:

```powershell
pnpm run build
pnpm start
pnpm start -- --continue
```

If the second command does not pass `--continue` through both pnpm layers, run:

```powershell
pnpm start -- -- --continue
```

Expected manual result:

- First terminal starts or connects to one daemon.
- Second terminal connects to the same daemon.
- Same-session prompts are globally FIFO.
- Double-`Esc` in the active terminal aborts the current run and the next queued prompt starts automatically.
- Closing all terminal clients lets the daemon exit after the idle timeout when the timeout is configured to a short test value.

- [ ] Request subagent review focused on:

```text
Review Phase 4 daemon auto-spawn and global FIFO. Check state-file/version/auth safety, stale daemon recovery, prompt ordering, permission ownership, idle shutdown, backend lease boundaries, CLI default daemon mode, tests, and docs. Report must-fix issues first with file/line evidence.
```

- [ ] Fix review findings with tests.

- [ ] Commit review fixes:

```powershell
$changed = git diff --name-only
git add -- $changed
git commit -m "fix(daemon): address phase four review findings"
```

---

## Self-Review

Spec coverage:

- Task 4.1 supervisor auto-spawn is covered by Task 4A.
- Task 4.2 global FIFO is covered by Task 4B and Task 4D E2E.
- Task 4.3 default terminal daemon is covered by Task 4C.
- Task 4.4 cross-terminal strict FIFO E2E is covered by Task 4D.
- Task 4.5 version handshake and idle exit are covered by Task 4A and Task 4D.
- Task 4.6 backend lease decision is covered by Task 4D.
- Subagent review and real `.env` smoke are listed in final verification.

Placeholder scan:

- No unresolved placeholder markers are present.
- Each task names exact files, commands, expected RED/GREEN outcomes, and commit boundaries.

Type consistency:

- `DaemonState`, `DaemonRuntimeHandle.connection`, `RemoteDaemonClientOptions.authToken`, `DaemonStartupIntent`, `DaemonPromptQueue`, and `backendLeaseMode` are introduced before later tasks rely on them.
- CLI fallback flags use both `--in-process` and `--no-daemon`; both map to the same in-process path.
