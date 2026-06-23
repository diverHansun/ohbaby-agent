# Web Session Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Web-only archive action that hides sessions from the sidebar by setting core session status to `archived`.

**Architecture:** Reuse the existing core `SessionManager.update()` status field and expose it through a narrow Web REST route. The Web client calls the route, then refreshes the projected snapshot so the sidebar reflects backend state.

**Tech Stack:** TypeScript, Hono, React, lucide-react, Vitest, Playwright MCP for browser verification.

---

## File Map

- Modify `packages/ohbaby-agent/src/commands/types.ts`
  - Add optional `archiveSession(sessionId)` to `CommandSessionProvider`.
- Modify `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
  - Implement archive behavior in the session provider.
- Modify `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`
  - Cover archive status updates and active-session fallback.
- Modify `packages/ohbaby-server/src/app/create-app.ts`
  - Add OpenAPI doc entry and `PATCH /v1/sessions/:id/archive`.
- Modify `packages/ohbaby-server/src/app/create-app.unit.test.ts`
  - Cover the new archive route.
- Modify `apps/ohbaby-web/src/api/daemon/http.ts`
  - Add `archiveSession()` HTTP method.
- Modify `apps/ohbaby-web/src/api/daemon/client.ts`
  - Add `archiveSession()` to `OhbabyWebClient` and `BrowserDaemonClient`.
- Modify `apps/ohbaby-web/src/api/daemon/client.integration.test.ts`
  - Cover browser client archive snapshot refresh.
- Modify `apps/ohbaby-web/src/ui/App.tsx`
  - Add archive icon and confirmation path to sidebar rows.
- Modify `apps/ohbaby-web/src/ui/App.unit.test.tsx`
  - Cover sidebar archive interactions.
- Modify `apps/ohbaby-web/src/ui/styles.css`
  - Keep row layout stable with an archive icon action.

## Task 1: Backend Capability

- [ ] Add `archiveSession?(sessionId: string): Promise<void> | void` to `CommandSessionProvider`.
- [ ] Add a focused contract test that creates two active sessions, archives the current one, and expects active session to move to the newest remaining active session.
- [ ] Add a focused contract test that archives the only active session and expects active session to become `null`.
- [ ] Implement archive in `ui-inprocess.ts` by calling `sessionManager.update(sessionId, { status: "archived" })`.
- [ ] After archiving, publish a snapshot replacement.
- [ ] Run backend contract tests:

```bash
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts --passWithNoTests
```

Expected: the new archive tests pass.

## Task 2: Server REST Route

- [ ] Add OpenAPI documentation for `PATCH /v1/sessions/{id}/archive`.
- [ ] Add a unit test that authorized registered clients can archive a session.
- [ ] Add unit tests for unauthorized, missing client id, and unregistered client cases.
- [ ] Implement `this.app.patch("/v1/sessions/:id/archive", ...)`.
- [ ] Call backend archive capability through the same backend adapter used by other session routes.
- [ ] Run server route tests:

```bash
pnpm exec vitest run packages/ohbaby-server/src/app/create-app.unit.test.ts --passWithNoTests
```

Expected: archive route tests pass.

## Task 3: Web Client

- [ ] Add `archiveSession(sessionId)` to `DaemonHttpClient`.
- [ ] Add `archiveSession(sessionId)` to `OhbabyWebClient` and `BrowserDaemonClient`.
- [ ] Refresh the projected snapshot after successful archive.
- [ ] Add tests for request URL/method and snapshot refresh.
- [ ] Run Web client tests:

```bash
pnpm exec vitest run apps/ohbaby-web/src/api/daemon/client.integration.test.ts apps/ohbaby-web/src/api/daemon/server-client.integration.test.ts --passWithNoTests
```

Expected: Web client archive tests pass.

## Task 4: Web Sidebar UI

- [ ] Replace the passive message icon in sidebar session rows with an archive icon button.
- [ ] Add browser confirmation before calling archive.
- [ ] Ensure archive clicks do not select the session row.
- [ ] Keep the existing disabled behavior while a run/composer action is active.
- [ ] Add unit tests for confirmed archive, cancelled archive, and no accidental selection.
- [ ] Run Web UI tests:

```bash
pnpm exec vitest run apps/ohbaby-web/src/ui/App.unit.test.tsx apps/ohbaby-web/src/ui/styles.unit.test.ts --passWithNoTests
```

Expected: sidebar archive UI tests pass.

## Task 5: Browser Verification

- [ ] Start or reuse the local Web server.
- [ ] Use Playwright MCP to inspect the browser at `http://127.0.0.1:4096/`.
- [ ] Confirm archive icons render in the sidebar.
- [ ] Archive a non-active session and verify the row disappears.
- [ ] Archive the active session and verify active-session fallback or empty state.

## Task 6: Review And Commits

- [ ] Run separate backend tests.
- [ ] Run separate frontend tests.
- [ ] Run Playwright browser verification.
- [ ] Dispatch subagent review focused on API semantics, active-session fallback, and Web interaction.
- [ ] Apply review fixes if needed.
- [ ] Commit docs first.
- [ ] Commit backend/API changes.
- [ ] Commit Web client/UI changes.
- [ ] Commit review fixes only if review produces changes.
