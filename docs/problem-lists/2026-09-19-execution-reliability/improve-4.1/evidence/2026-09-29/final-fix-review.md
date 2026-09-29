# Final combined fix scoped rereview

Range: **`2facccea..0ff1374a` plus its authorized same-round correction `0ff1374a..47605aaa` only**. Read `final-fix-brief.md`, `final-fix-report.md` and its addendum, both packaged diffs, and source/test dependencies needed to verify the seven accepted changes. No source edits, tests, builds, services, browser/model calls, or other agents. Both ranges passed `git diff --check`. This scratch report is the only write.

## Verdict

**PASS at `47605aaa` for spec and code quality within the seven accepted fixes.** The initial R1 P2 and R2 P3 below are both closed by the authorized same-round correction. They are retained as the review history and causal evidence; neither is an outstanding finding. No new execution-semantic or prompt/cache change was found. Compiled/visual execution acceptance remains the controller's separate check.

## Initial findings at 0ff1374a — both closed at 47605aaa

### R1 — P2: generic terminalReason masks the actual expected stop reason

Anchor: `apps/ohbaby-web/src/ui/session/SessionScreen.tsx:142–148`.

The helper chooses `prompt.error.terminalReason`, then `run.terminalReason`, before the `RUN_INTERRUPTED` message. Production Stop can provide `{status:"interrupted", error:{source:"runtime", code:"RUN_INTERRUPTED", message:"user-stop", terminalReason:"cancelled"}}`. This returns false from the new helper, so the original raw Stop alert remains after reload and in the inline projection.

This is derived from actual production paths, not a hypothetical malformed payload:

1. `runtime/run-manager/manager.ts:197–204` maps normal `cancel(runId,"user-stop")` to interrupted status.
2. On a worker returning after abort, `manager.ts:392–397` sets the cancellation status/reason **and** generic `terminalReason:"cancelled"`.
3. Terminal reconciliation retains this reason for the matching outcome (`manager.ts:540–551`); interrupted ledger writes intentionally have no richer `errorData`.
4. `adapters/ui-inprocess/prompt-mapper.ts:18–26` therefore creates the runtime RUN_INTERRUPTED error with both message `user-stop` and generic terminalReason `cancelled`.
5. The new helper gives generic `cancelled` priority over the concrete reason and rejects the expected-stop classification.

The analogous successful-abort path can occur for service shutdown. Worker throw/catch paths may omit terminalReason and already work through the legacy-message fallback, so a passing browser Stop case on one provider path would not disprove the other valid path.

The new App cases use typed `terminalReason:"user-stop"` or legacy message alone; the `cancelled` negative case uses `message:"runtime interrupted"`. They miss the production combination. Minimal correction: distinguish the specific expected stop/shutdown fact from the generic lifecycle `cancelled` marker. Do not suppress all generic cancellation or unexpected interruption. Correlated run input-close facts and/or the exact runtime RUN_INTERRUPTED stop message provide narrow existing evidence; no protocol/runtime change is needed. Add the actual mixed shape for both expected reasons to the formal-message and inline tests, while retaining generic cancelled+unknown-message and process-interrupted positive-error cases.

### R2 — P3: Web late acknowledgement can restore a notice cleared by editing

Anchor: `apps/ohbaby-web/src/ui/composer/Composer.tsx:1042–1049`; related `:161–165`.

Trigger: click Steer, edit the draft while its acknowledgement is pending, then receive success while the same Run/session remains active. `advanceEditRevision` clears the presentation on editing, but `onAccepted` compares only Run/session IDs and installs it again. The TUI fix includes a captured notice revision; Web does not. This is a small incomplete portion of the accepted “clear on new input” lifecycle, not lost input or changed Steer behavior. It also means a pending old callback can reappear after A→B→A if the original Run is still active, because identity equality alone does not distinguish a previous presentation lifetime.

Use a captured edit/scope generation for the request if closing this edge; preserve SteerButton's original-target retry identity. A controlled pending acknowledgement→draft edit→resolve test would demonstrate it. Existing new Web tests cover terminal-before/after-ack and then editing after the notice was already removed; they do not exercise this edge. This P3 can be explicitly deferred if the controller chooses to end the final wave, unlike R1's accepted normal-Stop behavior.

## Seven accepted fixes

| Accepted item | Source/quality assessment |
| --- | --- |
| 1. Steer presentation | **TUI passes.** Run-bound notice, layout-updated current target, session draft generation and edit revision guard stop stale acceptance. Existing steerAttempts/request IDs remain intact. Web correctly handles target termination/new Run and direct session mismatch, but R2 remains for edit/scope lifetime. Both terminal-before/after-ack tests are meaningful. |
| 2. Orphan result aria | **Pass.** Existing abnormal outcome or error feeds aria, explicit `showAbnormalDecoration={false}` preserves no-glyph policy. Parameterized errors/cancel/timeouts/no-execution preserve output/duration/detail checks. |
| 3. Expected interruption | **Incomplete: R1.** Sharing one local predicate between inline/formal projections is appropriately small; source gating and same-session run lookup avoid broad suppression. Reason precedence still misses the real mixed record. Genuine provider failures remain outside the predicate. |
| 4. Composer error placement | **Pass in source/tests; visual check remains controller-owned.** ErrorBanner and failed notices now sit inside real Composer `topContent`, alongside existing Todo/queue content. The later equal-specificity `.ohb-composer .ohb-error-banner` static-position rule overrides empty-page absolute placement. Existing view-level errors remain outside and edit/dismiss behavior is preserved. DOM ancestry tests now target `.ohb-composer-content`. |
| 5. Close control | **Pass in source/tests.** Explicit accessible name, existing actual consume callback, positioned compact button, header clearance, hover/focus states and long-text wrapping; composer notices are bounded by a scrolling max-height. No unrelated command semantics changed. |
| 6. Status wrapping | **Pass in source; controller visual evidence required.** Flex values and context can shrink, long values wrap, and narrow rows stack. Modal width/margins remain unchanged as requested. No assertion that static CSS review alone proves pixel-level overflow behavior. |
| 7. Error separator | **Pass.** Single neutral separator preserves the real failure plus unconfirmed transport message, including punctuation. Integration regression covers response loss and timeout without replay. |

## Scope, verification and handoff

The fourteen changed files match the accepted presentation/client-message/test scope. No protected execution prompt/cache files, ledger semantics, skill expansion, history accounting, or title punctuation changes. No new platform, dependency, or generalized error framework. Reported 357 targeted tests and hook lint/typecheck are implementer evidence inspected here, not a reviewer rerun.

The controller should resolve R1 with its minimal actual-record regression and complete the already-running compiled/browser checks. R2 is low severity and may be explicitly carried as a residual if not included in that local correction. This report does not request another broad review cycle, full-suite rerun, model sampling, or preservation of test screenshots. The user's final screenshot cleanup remains appropriate after the controller's remaining visual checks.

## Same-round correction verification at 47605aaa

Read `final-fix-correction.diff` and returned to the updated predicate, Composer request wrapper, existing edit/scope counters, and SteerButton source. The initial handoff and table verdicts above are superseded for items 1/3 by these results.

- **R1 closed.** The helper now recognizes a missing or generic `cancelled` terminal marker as insufficient to override an exact runtime `RUN_INTERRUPTED` reason. The actual `cancelled + user-stop` and `cancelled + service-shutdown` production shapes are quiet, while `cancelled + runtime interrupted`, `cancelled + process-interrupted`, and specific unexpected terminal reasons remain errors. Both formal-message/remount/session-return fixtures and inline expected-stop fixtures now contain the actual mixed shape. The existing source/status gates remain narrow; no durable fact or Run classification changed.
- **R2 closed.** Composer captures `draftScopeGeneration` and `editRevision` when it actually calls `steerQueuedPrompt`, then checks those counters, the original requested Run and current session before installing the notice. Existing layout effects increment scope on workspace/session/client changes and unmount; edits increment revision. This closes pending-ack→edit and A→B→A restoration, while returning the original receipt and preserving SteerButton attempt identity. Making the unused callback optional has no remaining unconditional caller and changes only the presentation callback contract. New controlled tests cover both named interleavings and retain the edited draft assertion.
- **Remaining accepted items unchanged and still pass source review.** No expansion into skill display, history accounting, title parsing, execution inputs, or cache.
- **Verification attribution:** the implementer reports RED on the intended R1/R2 render assertions, then 191 passing tests across the three complete affected Web files plus successful normal lint/typecheck hooks. I inspected those test bodies and the report; I did not execute them. Incremental `git diff --check` passed and product/test working tree was clean at inspection. The controller reports actual visible errors, 443px Status wrapping and keyboard closing observed; those observations are not my browser execution.

Final outstanding scoped code findings: **0 P0/P1/P2/P3**. No additional code-review loop is requested. Finish the controller's already planned compiled normal-Stop check and remaining acceptance/documentation/cleanup; retain the broader documented limitations without reopening their implementation scope.
