# Unicode Workspace Header Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let Web and Node clients open, reconnect to, and stream from workspaces whose absolute paths contain Unicode without changing legacy ASCII header callers.

**Architecture:** Browser HTTP/SSE and Node JSON-RPC/SSE clients encode the workspace directory with `encodeURIComponent()` and set `x-ohbaby-directory-encoding: percent-utf8`. Daemon workspace routing decodes only when that marker is present; unmarked requests keep the existing raw-header behavior. Invalid marked values fail closed with a structured `INVALID_DIRECTORY` response.

**Tech Stack:** TypeScript, browser Fetch/SSE, Hono daemon, Vitest.

---

## Validated design

`x-ohbaby-directory` is currently a raw HTTP header. Browser Fetch rejects code points outside ISO-8859-1 before any request reaches the daemon, so this affects Chinese, Japanese, Korean, Arabic, emoji, and other Unicode directory names. JSON request bodies already carry Unicode correctly; the failing boundary is the scoped HTTP/SSE header.

Alternatives considered:

1. Move the scope to a query string. This works for Unicode but changes every workspace route and exposes directory paths in URLs.
2. Replace the header with a server-issued scope ID. This is a larger protocol/state change and is unnecessary for the current bug.
3. Percent-encode the header with an explicit encoding marker. This keeps the existing routing shape, is ASCII-safe, and preserves old raw ASCII callers. **Selected.**

## Task 1: Encode scoped client headers

**Files:**
- Create: `packages/ohbaby-sdk/src/workspace-directory-header.ts`
- Modify: `apps/ohbaby-web/src/api/daemon/http.ts`
- Modify: `apps/ohbaby-web/src/api/daemon/events.ts`
- Modify: `packages/ohbaby-server/src/protocols/jsonrpc/client.ts`
- Test: `apps/ohbaby-web/src/api/daemon/workspace-switch.integration.test.ts`
- Test: `packages/ohbaby-server/src/protocols/jsonrpc/client.unit.test.ts`

**Step 1: Write failing Web tests**

Add a workspace switch using `D:\\Upan\\books\\learning materials\\李笑来作品集` and assert that all scoped HTTP and SSE headers are ASCII-only, contain the percent-encoded directory, and include `x-ohbaby-directory-encoding: percent-utf8`. Add the same assertion for the Node JSON-RPC client.

**Step 2: Run the focused test**

Run: `pnpm exec vitest run apps/ohbaby-web/src/api/daemon/workspace-switch.integration.test.ts packages/ohbaby-server/src/protocols/jsonrpc/client.unit.test.ts`

Expected: FAIL because the current header contains raw Unicode and Browser Fetch rejects it.

**Step 3: Implement the smallest shared header construction**

Encode only a configured scoped directory. Add the encoding marker only when the directory header is present. Put the protocol constants and helper in SDK, then reuse it in browser HTTP/SSE and Node JSON-RPC/SSE clients.

**Step 4: Run the focused test**

Run: `pnpm exec vitest run apps/ohbaby-web/src/api/daemon/workspace-switch.integration.test.ts packages/ohbaby-server/src/protocols/jsonrpc/client.unit.test.ts`

Expected: PASS.

## Task 2: Decode marked headers in daemon workspace routing

**Files:**
- Modify: `packages/ohbaby-server/src/runtime/daemon/server.ts`
- Test: `packages/ohbaby-server/src/runtime/daemon/global-server.integration.test.ts`

**Step 1: Write failing daemon tests**

Exercise a marked percent-encoded Chinese path through a workspace route and assert that the loaded scope is the original Unicode path. Add a malformed marked value case that returns structured `INVALID_DIRECTORY`. Keep an unmarked ASCII header case to prove backward compatibility.

**Step 2: Run the focused test**

Run: `pnpm exec vitest run packages/ohbaby-server/src/runtime/daemon/global-server.integration.test.ts`

Expected: FAIL because marked header values are currently treated as literal paths.

**Step 3: Implement guarded decoding**

Decode `x-ohbaby-directory` only when `x-ohbaby-directory-encoding` exactly equals `percent-utf8`. Convert decode failures to a 400 `INVALID_DIRECTORY` response before workspace dispatch.

**Step 4: Run the focused test**

Run: `pnpm exec vitest run packages/ohbaby-server/src/runtime/daemon/global-server.integration.test.ts`

Expected: PASS.

## Task 3: Verify and deliver

**Files:**
- Test: `apps/ohbaby-web/src/api/daemon/workspace-switch.integration.test.ts`
- Test: `packages/ohbaby-server/src/runtime/daemon/global-server.integration.test.ts`
- Test: `packages/ohbaby-server/src/protocols/jsonrpc/client.unit.test.ts`

**Step 1: Run affected regression tests**

Run: `pnpm exec vitest run apps/ohbaby-web/src/api/daemon/workspace-switch.integration.test.ts packages/ohbaby-server/src/runtime/daemon/global-server.integration.test.ts packages/ohbaby-server/src/protocols/jsonrpc/client.unit.test.ts`

**Step 2: Run quality gates**

Run: `pnpm run lint`, `pnpm run typecheck`, and `pnpm run build`.

**Step 3: Commit**

Stage the plan and implementation together only after the checks pass:

```powershell
git add docs/plans/2026-07-14-unicode-workspace-header-plan.md packages/ohbaby-sdk/src apps/ohbaby-web/src/api/daemon packages/ohbaby-server/src
git commit -m "fix(web): encode Unicode workspace headers"
```
