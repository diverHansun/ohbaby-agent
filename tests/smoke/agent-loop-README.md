# Real production agent-loop E2E

This opt-in harness enters `createPersistentUiBackendClient.submitPromptAndWait`, uses the actual provider SDK and local SQLite, and restricts tool permissions to the temporary read fixture. Ordinary test runs do not load credentials or make paid requests.

Run from the repository root. The runner loads `.env` without printing credentials. Select one fixed profile and mode; no model fallback occurs.

```sh
node scripts/run-real-agent-loop-e2e.mjs --profile=zenmux-deepseek-v41-chat --mode=stage-a
node scripts/run-real-agent-loop-e2e.mjs --profile=zenmux-gpt56-luna-responses-context --mode=e1
node scripts/run-real-agent-loop-e2e.mjs --profile=zenmux-claude-sonnet5-anthropic-context --mode=e1
node scripts/run-real-agent-loop-e2e.mjs --profile=zenmux-gpt56-luna-responses-context --mode=length-terminal
```

The same selectors are available as `OHBABY_REAL_AGENT_LOOP_PROFILE` and `OHBABY_REAL_AGENT_LOOP_MODE`. `OHBABY_REAL_AGENT_LOOP_EVIDENCE_DIR` overrides the default `.ohbaby/test-evidence/improve-7/live-loop` directory. Every run writes timestamped, sanitized audit/session evidence, including failures; reruns do not overwrite earlier results. Each run has a 20-HTTP guard including SDK retries, title generation and metadata. Repeating a failed case requires an explicit reason and retains the earlier evidence.

| Mode | Assertions |
| --- | --- |
| `stage-a` | One real read, final answer, nonempty execution IDs replayed as paired calls/results in subsequent actual HTTP. Completion counts are retained as baseline without requiring Stage B semantics. |
| `e1` | Two sequential real reads, a missing-file business error followed by successful retry after the test fixture is restored, normal continuation, SQLite close/reopen and continuation. Each accepted request emits one completion. |
| `length-terminal` | **Responses only, Stage B gate.** First agent request uses an explicit test output budget of 128 and disabled reasoning. Requires a real exhausted `length` terminal, failed Run with `output_length`, persisted visible text/usage, exactly one completion, no tool execution, native acceptance, retry or automatic continuation. Does not run Stage C history checks. |
| `length` | The same real Responses truncation followed by a user request and SQLite reopen; checks saved-body projection and exactly one fixed incomplete notice in actual HTTP. |
| `transport` | Injects local `ECONNRESET` while consuming a real upstream stream after at least 64 visible characters. Checks no automatic retry, saved-body projection, continuation and SQLite reopen. This is a local fault, not evidence of an upstream outage. |
| `cancel` | Calls the real backend `abortRun` while consuming a real upstream stream after at least 64 visible characters. Checks cancelled-body exclusion and one cancellation notice across continuation and SQLite reopen. |
| `compaction` | Two real reads, controlled redundant context, production force compaction with a real nonempty `stop` summary, native retirement, continuation and SQLite reopen. Force does not prove natural 95% crossing or a real upstream overflow. |

`length`, `transport`, `cancel` and `compaction` are full-contract gates; do not use their unfinished later-stage requirements to classify an earlier implementation batch. See each run's artifact and the improve-7 acceptance record for actual execution status. Tool-stage cancellation and failed-history selection during real compaction need additional coverage; the current modes alone do not prove those cases.

Only hashes, counts, role/type names, call IDs, fixed error classes and protocol diagnostics are saved. Native opaque payloads, authentication headers and upstream error messages are excluded. Visible request text stays in memory for assertions. A protocol-validation error can be recorded only when its message matches the fixed local allowlist; other error messages are hashed.

Non-paid verification:

```sh
pnpm exec tsc -p tests/smoke/agent-loop.tsconfig.json --pretty false
pnpm exec vitest run tests/smoke/agent-loop-observer.unit.test.ts
```
