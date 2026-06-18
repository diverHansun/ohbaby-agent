# ohbaby-server v0.1.5 Stable Kernel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the v0.1.5 server stable kernel scope from `docs/ohbaby-server/hono-app/07-v0.1.5-stable-server-kernel.md`.

**Architecture:** Keep default CLI on the direct in-process backend path. Move explicit server transport from hand-written Node HTTP to a Hono app while preserving `/api/*` jsonrpc compatibility. Extract per-client view logic into coordination and add an event-bus so SSE can replay missed events.

**Tech Stack:** TypeScript, Vitest, Hono, `@hono/node-server`, existing `ohbaby-sdk` `UiBackendClient` contract.

---

### Task 1: v0.1.5 Scope Documentation

**Files:**
- Create: `docs/ohbaby-server/hono-app/07-v0.1.5-stable-server-kernel.md`
- Modify: `docs/ohbaby-server/hono-app/README.md`
- Create: `docs/plans/2026-06-18-ohbaby-server-v0.1.5-stable-kernel.md`

**Step 1: Write the scope document**

Document that v0.1.5 includes M1-M4 only and defers M5/M6.

**Step 2: Verify docs are readable**

Run: `Get-Content -Raw -Encoding UTF8 docs\ohbaby-server\hono-app\07-v0.1.5-stable-server-kernel.md`

Expected: UTF-8 content renders correctly.

**Step 3: Commit**

```bash
git add docs/ohbaby-server/hono-app/07-v0.1.5-stable-server-kernel.md docs/ohbaby-server/hono-app/README.md docs/plans/2026-06-18-ohbaby-server-v0.1.5-stable-kernel.md
git commit -m "docs(server): scope v0.1.5 stable kernel"
```

### Task 2: Extract Client View Coordination

**Files:**
- Create: `packages/ohbaby-server/src/coordination/client-view.ts`
- Create: `packages/ohbaby-server/src/coordination/client-view.unit.test.ts`
- Modify: `packages/ohbaby-server/src/runtime/daemon/server.ts`

**Step 1: Write failing tests**

Cover:
- startup intent chooses resume/continue/fresh active session.
- snapshot projection hides inactive session messages and status.
- session-scoped events are delivered only to the active session client.
- command ownership routes command events to the invoking client.

Run: `pnpm exec vitest run packages/ohbaby-server/src/coordination/client-view.unit.test.ts`

Expected: FAIL because `client-view.ts` does not exist.

**Step 2: Move behavior into `client-view.ts`**

Extract pure types/functions/classes from `server.ts`:
- client view state.
- startup intent parsing/resolution.
- snapshot projection.
- event routing and ownership bookkeeping.

**Step 3: Wire `server.ts` to the extracted module**

Replace local helpers and maps with the new coordination unit while preserving `/api/*` behavior.

**Step 4: Verify**

Run:

```bash
pnpm exec vitest run packages/ohbaby-server/src/coordination/client-view.unit.test.ts
pnpm exec vitest run packages/ohbaby-server/src/runtime/daemon/server.integration.test.ts packages/ohbaby-server/src/runtime/daemon/client.integration.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/ohbaby-server/src/coordination/client-view.ts packages/ohbaby-server/src/coordination/client-view.unit.test.ts packages/ohbaby-server/src/runtime/daemon/server.ts
git commit -m "refactor(server): extract client view coordination"
```

### Task 3: Introduce Hono JSON-RPC Transport

**Files:**
- Modify: `packages/ohbaby-server/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `packages/ohbaby-server/src/app/create-app.ts`
- Create: `packages/ohbaby-server/src/app/create-app.unit.test.ts`
- Create: `packages/ohbaby-server/src/middleware/auth.ts`
- Create: `packages/ohbaby-server/src/protocols/jsonrpc/rpc-route.ts`
- Create: `packages/ohbaby-server/src/transport/node-listen.ts`
- Modify: `packages/ohbaby-server/src/runtime/daemon/server.ts`

**Step 1: Add Hono dependencies**

Run: `pnpm add hono @hono/node-server --filter ohbaby-server`

Expected: package and lockfile update only for `ohbaby-server`.

**Step 2: Write failing app tests**

Cover:
- `GET /api/health` succeeds with a valid bearer token.
- missing/incorrect token is rejected.
- `POST /api/rpc` preserves jsonrpc response shape.
- `GET /api/events` writes the existing `hello` event shape.

Run: `pnpm exec vitest run packages/ohbaby-server/src/app/create-app.unit.test.ts`

Expected: FAIL because app files do not exist.

**Step 3: Implement Hono app and jsonrpc route**

Move request parsing, RPC dispatch, health, shutdown, and SSE compatibility routes behind Hono handlers.

**Step 4: Switch `createDaemonHttpServer` to Hono listen**

Keep the exported `createDaemonHttpServer` handle shape so existing callers and tests do not change.

**Step 5: Verify**

Run:

```bash
pnpm exec vitest run packages/ohbaby-server/src/app/create-app.unit.test.ts
pnpm exec vitest run packages/ohbaby-server/src/runtime/daemon/server.integration.test.ts packages/ohbaby-server/src/runtime/daemon/client.integration.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/ohbaby-server/package.json pnpm-lock.yaml packages/ohbaby-server/src
git commit -m "feat(server): introduce hono jsonrpc transport"
```

### Task 4: Add Replayable Event Bus

**Files:**
- Create: `packages/ohbaby-server/src/coordination/event-bus.ts`
- Create: `packages/ohbaby-server/src/coordination/event-bus.unit.test.ts`
- Modify: `packages/ohbaby-server/src/app/create-app.ts`
- Modify: `packages/ohbaby-server/src/runtime/daemon/server.integration.test.ts`
- Modify: `packages/ohbaby-server/src/protocols/jsonrpc/client.ts`
- Modify: `packages/ohbaby-sdk/src` only if a minimal optional connection-state contract is needed.

**Step 1: Write failing event-bus tests**

Cover:
- publish assigns monotonic sequence numbers.
- replay after `Last-Event-ID` returns only missed events.
- too-old cursor returns `resync-required`.
- realtime subscribers receive subsequent events.

Run: `pnpm exec vitest run packages/ohbaby-server/src/coordination/event-bus.unit.test.ts`

Expected: FAIL because `event-bus.ts` does not exist.

**Step 2: Implement event-bus**

Use a bounded ring buffer and emit SSE `id` values from the envelope sequence number.

**Step 3: Wire `/api/events` to event-bus**

Parse `Last-Event-ID`, send replay before realtime, and preserve `hello` compatibility for existing clients.

**Step 4: Add integration coverage**

Simulate an SSE disconnect, publish events while disconnected, reconnect with `Last-Event-ID`, and assert the missed interval arrives in order.

**Step 5: Verify**

Run:

```bash
pnpm exec vitest run packages/ohbaby-server/src/coordination/event-bus.unit.test.ts
pnpm exec vitest run packages/ohbaby-server/src/runtime/daemon/server.integration.test.ts packages/ohbaby-server/src/runtime/daemon/client.integration.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/ohbaby-server/src packages/ohbaby-sdk/src
git commit -m "feat(server): add replayable event bus"
```

### Task 5: Final Verification and Review

**Files:**
- Inspect all changed files.

**Step 1: Run release-gate commands**

```bash
pnpm --filter ohbaby-server build
pnpm run typecheck
pnpm run test:unit
pnpm run test:integration
pnpm run build
rg "from \"hono\"|from 'hono'" packages/ohbaby-cli packages/ohbaby-agent
```

Expected: build/typecheck/tests pass; `rg` returns no matches.

**Step 2: Run git review**

```bash
git status --short
git log --oneline --decorate -n 8
git diff origin/main...HEAD --stat
git diff origin/main...HEAD
```

Expected: branch contains batched commits and no unrelated changes.

**Step 3: Request subagent code review**

Ask a code-reviewer subagent to review the branch against M1-M4 scope, focusing on:
- default CLI isolation.
- Hono middleware/auth semantics.
- jsonrpc compatibility.
- SSE replay correctness.
- tests proving the release gates.

**Step 4: Address Critical/Important feedback**

Fix review issues with TDD and commit follow-ups.

