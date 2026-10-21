# Real backend context / request / cache validation

Three selected Zenmux protocols used the existing createFormalCacheSession and installFormalCacheObserver harness without modifying repository files. Profile overrides are explicitly supported by the helper. Exact profiles came from COMPACT_TOKEN_PROFILES. Entry: real persistent agent backend submitPromptAndWait; the root tsx loader resolves ohbaby-llm through tsconfig paths to packages/ohbaby-llm/src/index.ts. This group verifies the migrated package source through the real backend; the separate real-process matrix and compiled Web tests verify compiled artifacts. No mocked provider responses were used.

Each protocol ran one synthetic fixture read task plus one conversation-only followup, with title generation and model metadata included in its request count. Helper guard capped each protocol at 10 HTTP; actual counts were 5, 6 and 5. No request was repeated to force a cache hit. All provider operations exhausted and settled. Read permission was scoped to the temporary fixture.

## Final assessment

| Profile | Assessment | HTTP including title/metadata | Detected full window | Main input cumulative | Cache read cumulative | Cache write cumulative | Session read share |
| --- | --- | --- | --- | --- | --- | --- | --- |
| zenmux-deepseek-openai-compatible | PASS | 5 | 1000000 | 28441 | 26368 | unreported (normalized 0) | 92.71% |
| zenmux-luna-openai-responses | PASS_WITH_LIMITATIONS | 6 | 1050000 | 31594 | 23539 | 8043 | 74.50% |
| zenmux-sonnet-anthropic | PASS_WITH_LIMITATIONS | 5 | 1000000 | 43750 | 14652 | 29092 | 33.49% |

All three protocols have actual provider cache-read tokens greater than zero. Parameter presence alone was never used to infer a hit. Session cache percentages are cumulative across agent-step requests, exclude title requests, and equal sum(cacheRead)/sum(inclusive input). The Anthropic first two requests wrote cache but read zero; only its followup produced a hit.

## Structure and order

- Chat uses messages with system first, then a user environment/reminder row and user prompt. Later requests retain those rows and append assistant tool_calls then tool result, followed by final assistant and next user. Its raw wire prefix hashes are stable.
- Responses moves system content to instructions and uses input rows. The user/reminder rows precede function_call then matching function_call_output. Its full raw input prefixes remain stable across requests. Luna also attempted a skill tool call that failed before its one completed fixture read; both exchanges paired correctly, and no further tool appeared on followup. This is a scenario limitation, not silently counted as an exact one-tool trace.
- Anthropic uses separate system and tools, and messages with adjacent user content grouped. Tool use appears in assistant content tool_use; the following user content contains tool_result. All call/result IDs are hashed, paired, unique and ordered. Its original wire JSON prefix hashes change as cache_control moves to the last eligible block. Production applyLastBlockCacheControl explains this behavior. Provider-neutral message hashes prove the full prior context is retained. A second semantic wire hash excluding cache_control was not captured, so byte-for-byte wire append-only is explicitly not claimed.
- System and tool digests are identical across all main requests within every session. No full system prompt, request content, tool result or header was persisted in evidence.

## Usage normalization

Every main request matches the provider fields that were reported after accounting for protocol semantics. Chat did not report cache-write usage: normalized cacheWrite is 0 with observed.cacheWrite=false, which means unknown rather than a measured zero. Chat/Responses input_tokens or prompt_tokens is already inclusive. Anthropic input_tokens is uncached input; normalized inputTokens equals input_tokens + cache_read_input_tokens + cache_creation_input_tokens. Zenmux Responses exposes writes at input_tokens_details.cache_write_tokens; the production normalizer preserves them.

The initial temporary audit omitted that Responses vendor field and incorrectly flagged write comparisons. audit-context.mjs corrected the evidence calculation offline, with no new HTTP or production change. Original runner outputs are retained so this correction is inspectable.

## Context occupancy meaning

All backend getContextWindowUsage ratios equal currentTokens / the detected full contextWindowTokens. Denominators were 1,000,000 for DeepSeek and Sonnet, 1,050,000 for Luna.

The numerator is a local estimate of the prepared context, including system, tools, messages and native replay state; it is not the provider's billable uncached input and not simply the last provider input count. estimateTokensForText uses 0.25 per ASCII codepoint and 1.3 per non-ASCII codepoint with ceiling. estimatePreparedRequestHeuristic also counts tools and native state.

Context manager applies a per-session calibration factor: initial factor 1; after a completed main request it updates factor to 0.5 * clamp(providerInclusiveInput / sentHeuristic, 0.5, 3) + 0.5 * previousFactor. currentTokens is round(nextPreparedHeuristic * factor). assessment.json reproduces every emitted context-update numerator exactly for all three protocols. Thus the Chat estimate can decrease from 9,965 to 9,810 while conversation grows: calibration moves the estimate closer to observed input. The backend query returns its latest committed preparation measurement, rather than counting the next response immediately after generation. Composition buckets remain local heuristic attribution and need not sum to the calibrated total.

## Commands and files

Run from /Users/hansun025/Projects/code-cli/ohbaby-agent:

```sh
node --import ./node_modules/tsx/dist/loader.mjs /tmp/ohbaby-llm-extraction-20261021/real-context/run-context.mts > /tmp/ohbaby-llm-extraction-20261021/real-context/run.log 2>&1
node /tmp/ohbaby-llm-extraction-20261021/real-context/audit-context.mjs
```

The first command exited 1 because of the original strict Anthropic raw-prefix assertion and the temporary Responses cache-write audit omission described above. The offline audit distinguishes verified properties from limitations. assessment.json contains corrected assertions, exact numeric calibration evidence and raw-vs-normalized comparisons. Per-profile .wire.json files are unmodified helper evidence, and per-profile .json files contain hashes, roles, types and numbers. No source tests/configs were changed, no build/commit/merge/push ran.

## Source locations

- `packages/ohbaby-agent/src/core/context/context-manager.ts:304`: observed input/heuristic ratio, clamped and updated through EMA; alpha/min/max are at lines 82–84.
- `packages/ohbaby-agent/src/core/context/context-manager.ts:368`: local heuristic multiplied by calibration factor to produce total currentTokens.
- `packages/ohbaby-agent/src/core/context/token-estimation.ts:164`: per-category composition is estimated independently from local payloads, without that calibration factor.
- `packages/ohbaby-agent/src/core/context/context-window-usage.ts:34`: calibrated currentTokens and composition are passed through independently; ratio divides currentTokens by contextWindowTokens.
- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts:3208`: getContextWindowUsage returns latest committed cached measurement when available.
- `packages/ohbaby-agent/src/adapters/ui-inprocess/prompt-cache-usage.ts:78`: accountedInputTokens comes from inclusive normalized usage.inputTokens. Lines 95–98 and 107–112 show the read-only numerator and cumulative ratio; cacheWrite is excluded from hit numerator.
- `packages/ohbaby-llm/src/providers/anthropic.ts:312`: applyLastBlockCacheControl moves ephemeral marker to last eligible block; buildRequestParams applies it at line 414.

Concrete Anthropic example: the followup's prepared local heuristic is 10,527 tokens and calibration factor is 1.2990672794735443, producing round(10527 × factor) = 13,675, exactly matching backend currentTokens. The independently estimated category composition therefore need not add to 13,675. The last provider reported input is 14,730 (including 14,652 cache-read and 76 cache-write, with 2 uncached), which is another distinct measurement.
