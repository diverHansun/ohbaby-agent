> Implementation working notes. Final acceptance is recorded in ../05-implementation-acceptance.md.

# improve-1 projection, SDK and TUI evidence

No commit, push or merge performed. S1+S2 internal gate was reported passed by root before this stage began.

## SDK and projection

Added mandatory independent permission query/event contracts, root binding and session-index types, real identity fields on requests, optional transport generation context on responses, lightweight selected/create/select session APIs, and unavailable/resync-required event types. Shared permission-sync implementation is owned by the permission_source agent; its exports were wired here.

Replaced asynchronous requested/resolved Bus projection with synchronous candidate construction and atomic replacement of immutable per-root snapshots. Frozen source ancestry and execution identity are checked. Critical callbacks invoke no observers. Committed notifications drain through a reentrancy-safe queue; subscriber failures remove only the failed subscription and synchronously invoke its error callback. Independent health prevents a broken root from returning a normal empty snapshot. Mode/rule Bus projection remains ordinary display state.

RED: original projection suite replacement had 8 failures (`/tmp/improve-1-projection-red.log`); implementation made all 8 pass. Further tests exposed reentrant event delivery [2,1] instead of [1,2] and changed ancestry accepted: 2 failures/8 passed (`/tmp/improve-1-projection-reentrant-red.log`). Serialized delivery and frozen-ancestry validation made 10/10 pass.

## TUI

The actual selected root and session index initialize independently of full chat history. Approval synchronization subscribes first, obtains the real epoch from the selected root's baseline, buffers bounded pre-baseline events, reuses that baseline as the recovery engine's first query, and shares a four-query budget with bootstrap retries. Actual transport replacement restarts recovery; old generation callbacks are disposed. Approval cards use independently synchronized data; ordinary permission events and full snapshot copies cannot overwrite it.

Dialog choices are disabled until ready. Source is `Main agent` or the child label/session ID. `[ / ]` selects any pending request. Cancel run choices are removed. Esc chooses Reject; run interruption remains a separate application control. Changing the selected request resets its local response state and old input callbacks cannot answer the previous request. Validated root changes do not wait for history refresh; old tests retaining the old selected root after history failure were intentionally updated.

RED: two new app tests failed before implementation: missing child cards while history hung, and Enter remained active after transport failure (`/tmp/improve-1-tui-red.log`). Final targeted TUI suite: 169 passed across app contract (103) and store unit (66). Additional tests cover temporary-query retry independent of failed history, same-call/new-ID cards, and stale snapshot non-resurrection. Ordinary reducer tests now explicitly assert it ignores requested/resolved input.

## Actual in-process integration

`tests/integration/agents/inprocess-child-permission.integration.test.ts` uses real createInProcessUiBackendClient, composition, scheduler, child lifecycle and a deterministic provider. It delegates an actual child bash command in a temporary directory, queries its approval from the root, rejects child-page query, sends two simultaneous replies, and verifies exactly one append (`x`), prompt success, actual child run identity, one requested/resolved pair and revision 1→2. A dedicated subscriber throws on the final resolved; its error callback fires immediately and another subscriber plus authoritative snapshot remain healthy. Backend and temporary directory are cleaned up.

Verification: permission directory + projection + actual inprocess integration: 101 passed in 8 files. TUI targeted suite: 169 passed in 2 files. Relevant production/test ESLint clean after final return-type cleanup. Full workspace typecheck is coordinated by root; latest observed remaining errors were outside these files. No claim of compiled PTY or real-model acceptance is made by these automated results.

## Follow-up boundary and review regressions

The compiled default TUI smoke test exposed a missed local RPC boundary: `subscribePermissionEvents` was treated as a JSON method, converting callback arguments to null and attempting to JSON-clone its unsubscribe function. The SDK proxy now keeps this subscription synchronous and bound to the connected implementation. Approval snapshot queries extract their argument-zero AbortSignal and pass it out of band, retaining abort delivery to the backend. No host factory API change was needed. A new unmocked `buildCoreAPIImpl` integration uses a temporary database and exercises the actual persistent-host-plus-RPC subscription, independent baseline and pre-aborted query. SDK tests also assert callback/receiver identity and pending-query abort delivery. RED: three failures, including the actual host failure and signal TypeError (`/tmp/improve-1-rpc-approval-red.log`). GREEN: 23 tests across RPC, host factory and new host integration (`/tmp/improve-1-rpc-approval-green.log`).

Fresh review reproduced stale dialog response callbacks: rejecting request A after switching to B displayed A's error, cleared B's pending flag and invoked B's resync. A per-identity token now includes request ID, epoch, root and binding generation; late callbacks also check mounted state. A synchronous pending ref prevents repeat submissions before React updates. RED: three failures (`/tmp/improve-1-tui-response-red.log`); GREEN: app/store/dialog 173 tests, then final expanded dialog cases cover epoch change and A→B→A (five tests). Final RPC/dialog/host focused run: 16 passed (`/tmp/improve-1-boundary-final.log`). Scoped ESLint and full `tsc --noEmit` passed. Root owns the compiled rebuild/PTY recheck; this agent did not rebuild.

Other follow-ups: unavailable TUI state no longer responds to retry keys or delivery failures by constructing a fresh sync engine (RED query count 1→2, GREEN app/store 170 tests). Real-process daemon fixtures now obtain persisted session IDs from `POST /v1/sessions` instead of inventing IDs; all nine original concurrency/recovery tests passed. Web/shared review findings were handed to their owner and reported fixed with independent regression coverage.
