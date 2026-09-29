# Compiled retained response-loss verification

2026-09-28 20:03–20:11 Asia/Taipei. Actual compiled CLI Web assets and remote TUI, real daemon HTTP/JSON-RPC and SQLite; local scripted model provider. No build by the verification agent.

`node scripts/run-improve4-ui-e2e.mjs --response-loss` with an interactive PTY started an isolated fixture. After cold restart, both prior running roots were interrupted and six queued messages became retained without automatic execution. Browser and remote TUI each edited and manually sent their B item.

The fixture proxy waited until each actual prompt was durably `succeeded`, then sent the first byte of the successful JSON response with its original full content length and destroyed the connection. Web received `Failed to fetch`; TUI received `returned invalid JSON: terminated`. Both retained the original attempted text and presented explicit retry. No client inferred success from the terminal status alone.

Web was refreshed before Retry: the original operation and frozen text persisted, Retry returned its original receipt, and `I4_WEB_ORIGINAL_DRAFT` was restored. TUI rejected attempted new typing, then Enter replayed the original operation/text, received its original receipt and restored `I4_TUI_ORIGINAL_DRAFT`. Both retries were verified in the proxy with deep equality of request and receipt.

- Exactly 2 durable `prompt_resubmission` rows, one per selected B item.
- Exactly 1 model request for `I4_WEB_RESPONSE_LOST` and 1 for `I4_TUI_RESPONSE_LOST`.
- Total provider requests: 2 initial HOLD requests plus those 2 resubmits; no retry-generated execution.
- Original promptId/userMessageId remained stable; one message and one durable run per executed selected prompt.
- Web C/E and TUI C/E remained retained.
- Fixture assertions and controller exited 0 with `failures: []`; remote TUI exited 0 through idle Ctrl+C.
- Owned daemon, remote TUI, provider and proxy closed; no owned daemon PID or proxy listener remained. Fixture auth manifest was replaced with cleanup metadata. Browser tab closed. Existing external daemon untouched.

Evidence: `response-loss-compiled.json`, `response-loss-durable-receipts.json`, `response-loss-pty-actions.json`, `response-loss-pty-frame.txt`, and Web screenshots before/after Retry.

An additional remote TUI footer defect was preserved in `remote-footer-state.json`: backend snapshot/control were idle, latest Run idle, older recovered Run error. `installSessionView` selected any old error after reversing the run list, causing the old interruption footer to reappear after success. This is separate from the receipt recovery success above and is being fixed under the same acceptance scope; do not interpret this report as clearing that footer defect.

Footer follow-up source validation: the projection now orders Run facts by parsed timestamps and retains explicit error provenance within the CLI store. Independent runtime errors, including identical text, are preserved across success-history views; only known Run-derived errors can be superseded. The actual-frame RED and subsequent independent-error RED both passed after correction. Final focused validation: 206 tests, CLI typecheck and scoped lint passed. The compiled footer recheck after the final root build is recorded below.

## Final compiled footer recheck — passed

After the final whole-repository test/build (472 files / 5,208 tests passed, 17 skipped), the newest compiled CLI reopened the same SQLite fixture via an actual remote PTY using `node scripts/run-improve4-remote-footer-recheck.mjs <completed-fixture-manifest>`.

The final root frame shows the successful retained response-loss execution and its normal footer, with no `error:` footer. The older interruption remains accurately represented in history; TUI C and E remain retained. A read-only child-view visit and return also preserved this corrected root projection. No model request was made (`modelRequests: 0`), and durable counts remained exactly 2 resubmission receipts and 4 Runs.

Idle Ctrl+C exited 0. The helper exited 0 and recorded daemon termination, provider closure and credential cleanup. The owned daemon PID was absent after exit. No production changes or new build occurred during this recheck.

Final evidence: `remote-footer-final-frame.txt` (normal rendered root frame), `remote-footer-final-pty.json` (actual input/output), and `remote-footer-final-check.json` (database and cleanup assertions). Original pre-fix state/PTY evidence above is retained for comparison. The focused source suite ultimately passed 206 tests after adding provenance guards for independent runtime errors.
