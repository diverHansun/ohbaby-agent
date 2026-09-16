# Real production agent-loop E2E

This opt-in harness enters `createPersistentUiBackendClient.submitPromptAndWait`, uses the actual provider SDK and local SQLite, and restricts tool permissions to the temporary read fixture. Ordinary test runs do not load credentials or make paid requests.

Run from the repository root. The runner loads `.env` without printing credentials. Select one fixed profile and mode; no model fallback occurs.

```sh
node scripts/run-real-agent-loop-e2e.mjs --profile=zenmux-deepseek-v41-chat --mode=stage-a
node scripts/run-real-agent-loop-e2e.mjs --profile=zenmux-gpt56-luna-responses-context --mode=e1
node scripts/run-real-agent-loop-e2e.mjs --profile=zenmux-claude-sonnet5-anthropic-context --mode=e1
node scripts/run-real-agent-loop-e2e.mjs --profile=zenmux-gpt56-luna-responses-context --mode=length-terminal
```

The same selectors are available as `OHBABY_REAL_AGENT_LOOP_PROFILE` and `OHBABY_REAL_AGENT_LOOP_MODE`. `OHBABY_REAL_AGENT_LOOP_EVIDENCE_DIR` overrides the default `.ohbaby/test-evidence/improve-7/live-loop` directory. Every run writes timestamped, sanitized audit/session evidence, including failures; reruns do not overwrite earlier results. Each run has a 20-HTTP guard including SDK retries, title generation and metadata. Repeating a failed case requires an explicit reason and retains the earlier evidence. Set `OHBABY_REAL_AGENT_LOOP_MAX_HTTP` to the remaining HTTP allowance (1–20) when a batch budget spans attempts; the harness refuses values above 20.

| Mode | Assertions |
| --- | --- |
| `stage-a` | One real read, final answer, nonempty execution IDs replayed as paired calls/results in subsequent actual HTTP. Completion counts are retained as baseline without requiring Stage B semantics. |
| `e1` | Two sequential real reads, a missing-file business error followed by successful retry after the test fixture is restored, normal continuation, SQLite close/reopen and continuation. Each accepted request emits one completion. |
| `length-terminal` | **Responses only, Stage B gate.** First agent request uses an explicit test output budget of 128 and disabled reasoning. Requires a real exhausted `length` terminal, failed Run with `output_length`, persisted visible text/usage, exactly one completion, no tool execution, native acceptance, retry or automatic continuation. Does not run Stage C history checks. |
| `length` | The same real Responses truncation followed by a user request and SQLite reopen; checks saved-body projection and exactly one fixed incomplete notice in actual HTTP. |
| `transport` | Injects local `ECONNRESET` while consuming a real upstream stream after at least 64 visible characters. Checks no automatic retry, saved-body projection, continuation and SQLite reopen. This is a local fault, not evidence of an upstream outage. |
| `cancel` | Calls the real backend `abortRun` while consuming a real upstream stream after at least 64 visible characters. Checks cancelled-body exclusion and one cancellation notice across continuation and SQLite reopen. |
| `tool-cancel` | Pauses on the production `tool:result` boundary, verifies its result is already durable in SQLite, then calls `abortRun`. Requires the accepted assistant/tool result to remain unchanged and paired, and one cancellation fact in the next actual request and after SQLite reopen. |
| `compaction` | Two real reads, locally interrupted real stream, locally cancelled real stream, redundant context and production force compaction. Actual summary HTTP must include the saved interrupted body and both fixed notices, exclude cancelled body/native data, and produce a nonempty `stop` summary. Requires original carriers to retire and stay retired after continuation/reopen without new assistant projections. Force does not prove natural 95% crossing or a real upstream overflow. |

`length`, `transport`, `cancel`, `tool-cancel` and `compaction` are full-contract gates; do not use their unfinished later-stage requirements to classify an earlier implementation batch. See each run's artifact and the improve-7 acceptance record for actual execution status. The `tool-cancel` and enhanced `compaction` modes must actually pass for their new boundary assertions to count as verified.

Only hashes, counts, role/type names, call IDs, fixed error classes and protocol diagnostics are saved. Native opaque payloads, authentication headers and upstream error messages are excluded. Visible request text stays in memory for assertions. A protocol-validation error can be recorded only when its message matches the fixed local allowlist; other error messages are hashed.

Non-paid verification:

```sh
pnpm exec tsc -p tests/smoke/agent-loop.tsconfig.json --pretty false
pnpm exec vitest run tests/smoke/agent-loop-observer.unit.test.ts
```


## Failed workspace retention

On a failed run, the harness closes SQLite and retains its original temporary workspace. Directories are restricted to `0700` and regular files to `0600`. A `*-resume.json` manifest identifies the original session/database/config paths, linked audit, code commit, profile, consumed HTTP count and credential environment-variable name. It contains no conversation body or opaque native payload. The audit links the retained workspace and manifest. Successful runs still remove their temporary workspace. Configuration retention rejects inline credential fields; the fixed profile uses only `ZENMUX_API_KEY` by environment-variable name.

The earlier final Responses E1 attempt `1789556080725` predates this mechanism: its SQLite was already deleted and its hashes cannot reconstruct the original native state. It cannot be resumed from the existing audit JSON. A fresh complete same-model E1 run needs a separately authorized allowance. Prepared command, **not executed without that authorization**:

```sh
OHBABY_REAL_AGENT_LOOP_MAX_HTTP=12 node scripts/run-real-agent-loop-e2e.mjs --profile=zenmux-gpt56-luna-responses-context --mode=e1
```

The normal path uses 10 HTTP requests (metadata + title + 8 agent steps). The last model run attempted one extra failed `skill` call, so that path would need 11; a 12-request ceiling allows one further variation but does not guarantee upstream/model behavior. This is a new full test, not continuation of the deleted session. A future retained-session follow-up can normally use one generation request, with a conservative separate ceiling of four including optional metadata verification and two SDK retries; no generic resume runner is introduced here.
