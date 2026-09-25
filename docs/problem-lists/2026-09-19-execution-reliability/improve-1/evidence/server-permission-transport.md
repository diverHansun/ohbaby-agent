> Implementation working notes. Final acceptance is recorded in ../05-implementation-acceptance.md.

# improve-1 S3 server and Remote permission transport

## Implemented contract

- Server startup and registration use the lightweight session index plus a null-root permission query for runtime epoch; they never call the full chat snapshot.
- Registered clients own `{ permissionEpoch, rootSessionId, bindingGeneration }`. Root selection validates metadata before changing the view. Queries, responses, selections, and concurrent registration recheck their captured binding after asynchronous metadata work.
- REST `/v1/permissions` and RPC `getPermissionSnapshot` return independent permission snapshots. REST response body `{ response, context }` and RPC third response argument carry the expected binding. Requests from unregistered clients, stale epochs, other roots, old generations, and A→B→A previous bindings fail closed.
- New-session APIs create fresh metadata. REST/RPC selections bind only the requesting client. Prompt acceptance carries the resulting binding. Child sessions cannot become a selectable root.
- Permission requested/resolved/unavailable events use the dedicated reliable backend subscription and bypass ordinary event sequence replay. Matching root pages all receive approval changes. A failed write closes only that connection, including failure of the final resolved frame. A failed dedicated forwarder disconnects streams and installs a new subscription.
- Every actual SSE connection sends hello with current epoch/root/generation after subscription is established. Binding changes notify connected clients. Raw permission revisions stay intact; snapshots never fabricate same-revision deltas.
- Remote exposes dedicated permission events, hello/resync bindings, and direct independent queries. The consumer's shared recovery engine owns the four-query budget; an unused duplicate Remote recovery engine was removed after independent review. Queries with active dedicated subscribers wait for a live hello. Delayed create/select/prompt receipts cannot overwrite a newer epoch or generation.
- Command interaction ownership stays client-owned. Permission owner/run maps were removed. Existing process fixtures now create actual session metadata (permission_core agent), preserving admission and crash-recovery scenarios.

## Feedback and validation

Initial failed-history startup regression failed before implementation (`/tmp/improve-1-server-red.log`: rejected with history unavailable), then passed with independent initialization.

Actual in-process agent + localhost HTTP/SSE integration exercises a real bash permission request, two bound pages, a fresh-page snapshot restore, RPC approval, actual prompt completion, and revision-2 empty pending state while full chat snapshots fail. The second variant throws on the final resolved SSE enqueue: affected connection closes, other page receives resolved, and fresh query recovers empty state without another permission event.

Additional tests cover asynchronous query/response scope races, child selection rejection, A→B→A stale contexts, epoch/root/auth parity, dedicated forwarder reinstall, raw permission events despite global sequence filtering and failed history, and delayed create/select/prompt receipt races after a newer hello.

Final commands:

- `pnpm exec vitest run packages/ohbaby-server`: **21 suites, 275 tests passed** (`/tmp/improve-1-server-final.log`). Includes the nine real-process global single-serve tests.
- `pnpm exec eslint packages/ohbaby-server/src`: **zero errors and warnings** (`/tmp/improve-1-server-lint-final.log`).
- `pnpm typecheck`: passed (`/tmp/improve-1-server-typecheck-final.log`).

No commit or push performed. Full repository gates and actual Web/TUI acceptance are owned by the root task.

## Pi review follow-up (2026-09-25)

Verified the external P1/P2 reports before changing code:

- P2 RED: five real RemoteDaemonClient + localhost server tests timed out waiting for `command.result.delivered(session.selected)` after `/new` and supported `/resume` argument forms (`/tmp/improve1-review-command-red.log`).
- P1 RED: six same-root REST prompts followed by another client's session selection produced an unchanged hello on the observer connection (`/tmp/improve1-review-hello-red.log`).

Fixes:

- Metadata-only RPC `/new` and `/resume` now emit owner-routed `command.started`, data output (`session.created` / `session.current`), `session.selected`, and failure events with a single command identity. They do not invoke the shared backend command handler or read full history. The built-in resume grammar is preserved: underscore/hyphen flags, equals forms, positional ID, and missing/invalid-ID failure behavior. `/new` continues the explicitly approved always-fresh per-client API behavior; `--no-reuse-empty-session` remains accepted. The local backend command's legacy empty-session reuse is unchanged.
- REST prompt acceptance compares binding generations before sending hello. Backend `session.selected` events send hello only to clients whose generation actually changed; other pages receive no redundant confirmation.
- Source agent owns the separate SDK change that makes a same-connection/same-binding ready confirmation a no-op, without resetting recovery budget.

Final verification after the fixes:

- `pnpm exec vitest run packages/ohbaby-server`: **21 suites / 296 tests passed**, including real-process tests and the expanded permission integration suite (`/tmp/improve1-review-server-all.log`).
- `pnpm exec eslint packages/ohbaby-server/src`: clean, no warnings (`/tmp/improve1-review-server-lint2.log`).
- `pnpm typecheck`: passed (`/tmp/improve1-review-server-types2.log`).

No build, commit, or push performed during this follow-up. Root owns compiled browser acceptance.
