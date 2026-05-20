# 2026-05-20 Runtime Dataflow and Compact Gap

This note records the current runtime dataflow, the real status of compact, and
the next implementation boundary. It is intentionally factual: it describes what
the current code path does today, not only what earlier architecture documents
planned.

## Conclusions

- `compact` is the product-level term. Internally the current context module has
  `prune()` and `compress()`, but the user-facing capability should be described
  as compact.
- Compact is not complete for MVP dogfood. The context module has partial
  implementation and tests, but TUI prompt submission does not yet route through
  `ContextManager`.
- Runtime middleware lite is not a current implementation target. Deer-flow's
  thread middleware is useful as a reference for phase boundaries, but the next
  step should wire existing modules into the single-process runtime path.
- The highest-value P1 work is to make the TUI run path use the same
  `MessageManager -> ContextManager -> Lifecycle -> ToolScheduler -> Runtime`
  chain that the architecture expects.

## Current TUI Prompt Dataflow

Current path when the user submits a prompt from TUI:

```text
OhbabyTerminalApp
  -> UiBackendClient.submitPrompt()
  -> packages/ohbaby-agent/src/adapters/ui-inprocess.ts
     - writes UiMessage to UiStateStore
     - writes user text to core MessageManager
     - starts run stream projection
     - builds model messages from UI snapshot messages
  -> createUiRuntimeComposition().buildPromptMessages()
     - builds system prompt/custom instructions
     - appends caller-provided messages
  -> RunManager.create()
  -> RunWorker.start()
  -> Lifecycle.run()
  -> LLMClient.streamChatCompletion()
  -> ToolScheduler.executeBatch()
  -> RunWorker publishes StreamBridge events
  -> run-stream-adapter projects events back into UiStateStore
  -> TUI renders snapshot/events
```

The main gap is the message source used before the run starts. The adapter calls
its local `toModelMessages(session.messages)` over the UI snapshot. That misses
the context module's compact policy and also ignores richer persisted core
message semantics.

Relevant files:

- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
- `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`
- `packages/ohbaby-agent/src/runtime/run-manager/manager.ts`
- `packages/ohbaby-agent/src/runtime/run-manager/worker.ts`
- `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts`
- `packages/ohbaby-agent/src/core/message/manager.ts`
- `packages/ohbaby-agent/src/core/context/context-manager.ts`

## Runtime's Actual Role

Runtime is the execution spine, not the reasoning brain and not the UI.

It currently owns:

- run identity and run status transitions;
- run ledger writes and crash recovery markers;
- concurrency policy for active runs;
- abort control through `AbortController`;
- sandbox lease acquisition and release;
- translation from lifecycle events into `StreamBridge` events;
- a stable stream boundary that TUI, CLI, and future server adapters can consume.

Runtime should not own:

- prompt assembly details;
- memory file semantics;
- compact summary quality;
- TUI rendering decisions;
- provider-specific prompt rules beyond passing model messages/tools through.

That boundary is healthy. The issue is not that runtime needs a new large
middleware framework; the issue is that context assembly is not yet placed at the
right boundary before `RunManager.create()`.

## Context, Memory, and Token Status

### What Exists

`packages/ohbaby-agent/src/core/context/context-manager.ts` already provides:

- `assemble(sessionId, directory, isSubagent?)`;
- `getUsage(context, modelId)`;
- `shouldCompress(usage)`;
- `prune(sessionId)`;
- `compress(sessionId, force?, modelId?)`.

`packages/ohbaby-agent/src/core/memory/memory-manager.ts` already loads global
and project memory.

`packages/ohbaby-agent/src/services/llm-model/tokenCounting.ts` provides a
heuristic token counter, model limits, usage ratio, and tests. It is compatible
with the `ContextManager` `TokenCounter` interface.

### What Is Missing

- TUI prompt submission does not call `ContextManager.assemble()`.
- The run path does not call compact before model invocation.
- The TUI does not yet expose compact state such as "context compacted",
  "compact skipped", or "compact failed".
- Long-term memory tools (`memory_list`, `memory_add`, `memory_update`,
  `memory_remove`) are defined as metadata and scheduler categories, but they
  are not registered as executable builtin tools in the current tool registry.
- `tokenCounting.ts` works as a utility, but it is not yet an active guardrail in
  the main TUI lifecycle.

## Compact Semantics

Use compact as the public term:

```text
compact = mechanical prune + optional LLM summary + rebuilt model context
```

Recommended internal phases:

1. **Measure**: estimate tokens for system prompt, memory, and message history.
2. **Prune**: mechanically mark old large tool outputs as compacted.
3. **Summarize**: if still above threshold, create a compact summary message.
4. **Reassemble**: rebuild model messages from core history after compact.
5. **Notify**: publish a visible notice/status so TUI can show the action.

The current `prune()`/`compress()` names can remain as internal implementation
details, but public commands, UI labels, docs, and tests should use compact.

## Lessons From Reference Projects

### claude-code

The query path treats compact as part of model-call preparation. It applies
microcompact before autocompact, then continues the current query using
post-compact messages. It also has reactive compact on prompt-too-long errors.

Useful takeaways:

- compact belongs before model invocation, not after the context has already
  overflowed;
- compact needs loop guards so one bad compact does not create repeated retries;
- compact should produce a boundary message visible to later context assembly.

### opencode

opencode models compaction as a hidden primary agent with a dedicated
compaction prompt and denied tools. The UI also has explicit compaction parts.

Useful takeaways:

- compact can be represented as its own internal agent/run mode;
- compact should not have tool permissions;
- UI should display compact as a small timeline event, not a huge assistant
  message.

### deer-flow

deer-flow's middleware approach makes thread data, summarization, memory, usage,
and loop detection clear phase hooks around model/tool execution.

Useful takeaway:

- borrow the phase discipline, not the framework. For this MVP, explicit
  composition is enough.

## Recommended P1 Implementation Boundary

### P1-A: Add a Compact Facade

Add a small facade in `core/context` so callers can use compact terminology
without learning prune/compress internals.

Candidate API:

```ts
interface CompactResult {
  readonly status: "not-needed" | "pruned" | "compacted" | "failed" | "inflated";
  readonly usageBefore: ContextUsage;
  readonly usageAfter?: ContextUsage;
  readonly prune?: PruneResult;
  readonly compression?: CompressionResult;
  readonly summaryMessageId?: string;
  readonly error?: string;
}
```

The facade can internally call `assemble()`, `getUsage()`, `prune()`, and
`compress()`.

### P1-B: Wire ContextManager Into TUI Runtime Composition

Move prompt assembly responsibility out of local UI snapshot conversion.

Target shape:

```text
submitPrompt()
  -> write user message to core MessageManager
  -> runtime.preparePromptContext({ sessionId, projectRoot, agentName, modelId })
     -> ContextManager.assemble()
     -> compact if needed
     -> ContextManager.assemble() again
     -> MessageManager.toModelMessages(sessionId)
  -> RunManager.create({ messages, tools })
```

This preserves current runtime ownership: RunManager still executes runs; context
preparation happens before a run starts.

### P1-C: Add TUI-Visible Compact Notices

Compact must be visible but quiet.

Examples:

- `Context compacted: 18,240 -> 7,910 tokens`
- `Context prune skipped: usage 41%`
- `Context compact failed: summary model error; continuing with pruned context`

These should use the existing notice/status path rather than a new UI subsystem.

### P1-D: Clean Token Module Naming

`packages/ohbaby-agent/src/services/llm-model/tokenCalculation.ts` is only a
re-export of `tokenCounting.ts`. Since the package public export is the root
entrypoint and npm API is not stable yet, delete `tokenCalculation.ts` and keep
`tokenCounting.ts` as the canonical module name.

## Non-Goals For This Round

- Do not implement attachable server.
- Do not introduce runtime middleware lite as a new framework.
- Do not add MCP/plugin/skill.
- Do not add long-term memory editing tools unless compact wiring needs them.
- Do not redesign the TUI layout.

## Verification Matrix

Target tests:

- context unit tests for compact facade status transitions;
- ui-inprocess contract test proving `ContextManager.assemble()` is called for
  prompt submission;
- integration test proving old tool outputs are compacted before the second
  long prompt;
- TUI contract test proving compact notices render and dedupe;
- tokenCounting tests remain passing after deleting `tokenCalculation.ts`.

Smoke tests:

- fake LLM long-session compact smoke;
- real provider smoke with a long tool-heavy session after fake coverage is
  stable.

## Engineering Principle

Keep lifecycle narrow and runtime explicit:

- `ContextManager` decides what context should be sent.
- `MessageManager` owns durable conversation history.
- `RunManager` owns execution state and cancellation.
- `Lifecycle` owns one model/tool loop.
- `ToolScheduler` owns permission-aware tool execution.
- TUI owns presentation only.

The compact fix should connect these existing responsibilities instead of adding
a new architectural layer.
