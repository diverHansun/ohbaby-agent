# Reasoning Display Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream OpenAI-compatible reasoning to CLI/web as live-only UI state while keeping reasoning out of sqlite and cross-turn context, with same-turn tool-loop passback.

**Architecture:** Provider reasoning stays separate from assistant content in the streaming core. Lifecycle owns a per-run in-memory `Map<messageId, reasoning>` for same-turn passback and emits dedicated reasoning events with `messageId`. UI clients consume dedicated reasoning events into transient display state instead of snapshot message parts.

**Tech Stack:** TypeScript, Vitest, React, Ink, OpenAI-compatible chat completion types, ohbaby stream bridge, ohbaby SDK UI events.

---

### Task 1: Core Streaming Reasoning Responses

**Files:**
- Modify: `packages/ohbaby-agent/src/core/llm-client/types.ts`
- Modify: `packages/ohbaby-agent/src/core/llm-client/streaming.ts`
- Test: `packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts`

- [ ] **Step 1: Write failing streaming tests**

Add tests in `packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts` near the existing reasoning test:

```ts
it("should yield provider reasoning deltas without exposing them as assistant text", async () => {
  const events: InterfaceProviderStreamEvent[] = [
    { reasoningDelta: "think " },
    { reasoningDelta: "more" },
    { textDelta: "Visible answer" },
    { finishReason: "stop" },
  ];

  streamChatCompletionMock.mockResolvedValue(createProviderStream(events));

  const messages = [{ role: "user" as const, content: "test" }];
  const responses: StreamingResponse[] = [];

  for await (const response of streamChatCompletion(mockClient, messages)) {
    responses.push(response);
  }

  expect(
    responses.map((response) => ({
      content: response.completeMessage.content,
      reasoning: response.reasoning,
      reasoningDelta: response.reasoningDelta,
    })),
  ).toEqual([
    { content: "(Empty response)", reasoning: "think ", reasoningDelta: "think " },
    { content: "(Empty response)", reasoning: "think more", reasoningDelta: "more" },
    { content: "Visible answer", reasoning: "think more", reasoningDelta: undefined },
    { content: "Visible answer", reasoning: "think more", reasoningDelta: undefined },
  ]);
});
```

- [ ] **Step 2: Run the streaming test and verify red**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts -t "provider reasoning deltas"
```

Expected: FAIL because `StreamingResponse` has no `reasoning` fields and pure reasoning events are dropped.

- [ ] **Step 3: Implement streaming response fields**

Update `StreamingResponse` in `types.ts` with `reasoningDelta?: string` and `reasoning?: string`. In `streaming.ts`, add `let accumulatedReasoning = "";`, append `event.reasoningDelta` to it, remove the pure-reasoning `continue`, and include `reasoningDelta` and `reasoning` in yielded responses. Do not pass reasoning into `buildCompleteMessage`.

- [ ] **Step 4: Run the streaming test and verify green**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts -t "provider reasoning deltas"
```

Expected: PASS.

### Task 2: Context Serialization Same-Turn Passback

**Files:**
- Modify: `packages/ohbaby-agent/src/core/context/types.ts`
- Modify: `packages/ohbaby-agent/src/core/context/context-manager.ts`
- Modify: `packages/ohbaby-agent/src/core/context/serializer.ts`
- Modify: `packages/ohbaby-agent/src/core/message/converter.ts`
- Modify: `packages/ohbaby-agent/src/core/context/serialization.ts`
- Test: `packages/ohbaby-agent/src/core/context/serializer.integration.test.ts`
- Test: `packages/ohbaby-agent/src/core/message/manager.unit.test.ts`

- [ ] **Step 1: Write failing serializer tests**

Add a serializer integration test that creates an assistant message with a completed tool part and passes `activeReasoningByMessageId: new Map([[assistant.id, "deep thought"]])` to `serializeForLlm`. Expect the assistant message with `tool_calls` to include `reasoning_content: "deep thought"`.

Also add assertions that the field is absent when the map is empty and when the assistant message has text but no tool calls.

- [ ] **Step 2: Update legacy reasoning part model-message test**

Change the `manager.unit.test.ts` test named "converts text and reasoning parts to provider model messages" so the expected assistant model content excludes `"briefly"`. Rename it to "does not feed reasoning parts to provider model messages".

- [ ] **Step 3: Run serializer/message tests and verify red**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/core/context/serializer.integration.test.ts packages/ohbaby-agent/src/core/message/manager.unit.test.ts -t "reasoning"
```

Expected: FAIL because `reasoning_content` is not injected and legacy reasoning parts still serialize as text.

- [ ] **Step 4: Implement context passback and reasoning exclusion**

Add `activeReasoningByMessageId?: ReadonlyMap<string, string>` to `PrepareTurnInput` and `serializeForLlm`. Pass it through `context-manager.ts`. In `serializer.ts`, when serializing an assistant message with completed tool parts, add `reasoning_content` only if the map has a non-empty value for `message.info.id`. Remove reasoning text from `textContentFromParts`. In `message/converter.ts` and `context/serialization.ts`, make reasoning parts serialize to an empty string for model/context text.

- [ ] **Step 5: Run serializer/message tests and verify green**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/core/context/serializer.integration.test.ts packages/ohbaby-agent/src/core/message/manager.unit.test.ts -t "reasoning"
```

Expected: PASS.

### Task 3: Lifecycle Reasoning Events And No Persistence

**Files:**
- Modify: `packages/ohbaby-agent/src/core/lifecycle/types.ts`
- Modify: `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts`
- Test: `packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Add tests that fake stream responses with `reasoningDelta` before text and assert:

- emitted events include `llm:reasoning-delta` with `messageId`;
- emitted events include `llm:reasoning-end`;
- `messageManager.appendPart` is never called with `{ type: "reasoning" }`;
- the second `prepareTurn` call in a tool loop receives `activeReasoningByMessageId` containing the first assistant message id and reasoning text.

- [ ] **Step 2: Run lifecycle tests and verify red**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts -t "reasoning"
```

Expected: FAIL because lifecycle does not emit reasoning events or pass reasoning to `prepareTurn`.

- [ ] **Step 3: Implement lifecycle reasoning map and events**

Add `llm:reasoning-delta` and `llm:reasoning-end` to `LifecycleEvent`. Create `const activeReasoningByMessageId = new Map<string, string>();` in `run`. Pass it to every `prepareTurn`. In `runModelStep`, emit reasoning events using the created assistant message id, record the final accumulated reasoning on the returned step result, and ensure reasoning-end fires once when reasoning was seen.

- [ ] **Step 4: Run lifecycle tests and verify green**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts -t "reasoning"
```

Expected: PASS.

### Task 4: Runtime Bridge And SDK UI Events

**Files:**
- Modify: `packages/ohbaby-sdk/src/events.ts`
- Modify: `packages/ohbaby-agent/src/runtime/run-manager/worker.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/stream-bridge-run-event-source.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts`
- Modify: `packages/ohbaby-server/src/coordination/client-view.ts`
- Test: `packages/ohbaby-agent/src/adapters/ui-runtime/stream-bridge-run-event-source.unit.test.ts`
- Test: `packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts`

- [ ] **Step 1: Write failing bridge tests**

Add tests asserting `run.llm.reasoning.delta` and `run.llm.reasoning.end` bridge events translate to lifecycle reasoning events, and that `run-stream-adapter` publishes SDK events `message.reasoning.delta` and `message.reasoning.end` without mutating assistant message parts.

- [ ] **Step 2: Run bridge tests and verify red**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-runtime/stream-bridge-run-event-source.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts -t "reasoning"
```

Expected: FAIL because the bridge does not understand reasoning events.

- [ ] **Step 3: Implement bridge and SDK event types**

Add SDK event interfaces for `message.reasoning.delta` and `message.reasoning.end`. Publish lifecycle reasoning events from `RunWorker` as `run.llm.reasoning.delta` and `run.llm.reasoning.end`. Translate those bridge events back in `stream-bridge-run-event-source.ts`. In `run-stream-adapter.ts`, publish SDK reasoning events without updating `UiMessage.parts`. Route the new event types by `sessionId` in `client-view.ts`.

- [ ] **Step 4: Run bridge tests and verify green**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-runtime/stream-bridge-run-event-source.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts -t "reasoning"
```

Expected: PASS.

### Task 5: Web Transient Reasoning State And Rendering

**Files:**
- Modify: `apps/ohbaby-web/src/api/daemon/wire.ts`
- Modify: `apps/ohbaby-web/src/api/daemon/eventReducer.ts`
- Modify: `apps/ohbaby-web/src/ui/selectors.ts`
- Modify: `apps/ohbaby-web/src/ui/App.tsx`
- Test: `apps/ohbaby-web/src/api/daemon/eventReducer.unit.test.ts`
- Test: `apps/ohbaby-web/src/ui/App.unit.test.tsx`

- [ ] **Step 1: Write failing web reducer tests**

Add tests showing `message.reasoning.delta` updates transient reasoning by `messageId`, `message.reasoning.end` marks it folded, and `replaceSnapshot` clears transient reasoning. Assert snapshot message parts remain unchanged.

- [ ] **Step 2: Write failing web UI test**

Add an App test that feeds a streaming assistant message plus transient reasoning state and expects `.ohb-reasoning` text to render while no reasoning part exists in the message.

- [ ] **Step 3: Run web tests and verify red**

Run:

```bash
pnpm vitest run apps/ohbaby-web/src/api/daemon/eventReducer.unit.test.ts apps/ohbaby-web/src/ui/App.unit.test.tsx -t "reasoning"
```

Expected: FAIL because no transient reasoning state exists.

- [ ] **Step 4: Implement web transient reasoning state**

Extend `ViewState` with `reasoningByMessageId`. Update `reduceUiEvent` for `message.reasoning.delta`, `message.reasoning.end`, `message.part.delta`, `message.updated`, `run.updated`, and `snapshot.replaced` so reasoning folds or clears at the right boundaries. Pass transient reasoning into the view model and render a `details` block in `MessageRow` when reasoning exists for that message id.

- [ ] **Step 5: Run web tests and verify green**

Run:

```bash
pnpm vitest run apps/ohbaby-web/src/api/daemon/eventReducer.unit.test.ts apps/ohbaby-web/src/ui/App.unit.test.tsx -t "reasoning"
```

Expected: PASS.

### Task 6: CLI Transient Reasoning Rendering

**Files:**
- Modify: `packages/ohbaby-cli/src/tui/store/events.ts`
- Modify: `packages/ohbaby-cli/src/tui/store/transcript.ts`
- Modify: `packages/ohbaby-cli/src/tui/components/message/message-row.tsx`
- Test: `packages/ohbaby-cli/src/tui/app.contract.test.tsx`
- Test: `packages/ohbaby-cli/src/tui/store/transcript-commit.unit.test.ts`

- [ ] **Step 1: Write failing CLI contract test**

Add a contract test that feeds `message.reasoning.delta`, a normal text delta, and completion events. Expect live reasoning text to appear before content, then fold to the existing `"Thought"` summary after content or reasoning end.

- [ ] **Step 2: Run CLI tests and verify red**

Run:

```bash
pnpm vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx -t "reasoning"
```

Expected: FAIL because CLI does not consume reasoning UI events.

- [ ] **Step 3: Implement CLI transient reasoning handling**

Extend the CLI event reducer to keep live reasoning per message id as transient message-part data during the active run. Fold it on `message.reasoning.end`, first `message.part.delta`, or terminal `message.updated`. Keep legacy reasoning part rendering intact for old snapshots.

- [ ] **Step 4: Run CLI tests and verify green**

Run:

```bash
pnpm vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx packages/ohbaby-cli/src/tui/store/transcript-commit.unit.test.ts -t "reasoning"
```

Expected: PASS.

### Task 7: Persistence And Integration Guards

**Files:**
- Test: `packages/ohbaby-agent/src/core/message/database-store.integration.test.ts`
- Test: `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`
- Test: `apps/ohbaby-web/src/api/daemon/server-client.integration.test.ts`

- [ ] **Step 1: Write integration guard tests**

Add integration coverage that runs a provider stream containing reasoning and asserts:

- no `reasoning` part appears in the persisted assistant message;
- UI event subscribers receive reasoning events;
- web daemon reducer receives reasoning events without storing them in snapshot parts.

- [ ] **Step 2: Run integration guard tests and verify red or green appropriately**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts apps/ohbaby-web/src/api/daemon/server-client.integration.test.ts -t "reasoning"
```

Expected: New tests should fail before the relevant implementation tasks and pass after Tasks 1-6.

- [ ] **Step 3: Adjust implementation only if integration exposes a gap**

If integration tests fail after Tasks 1-6, patch the narrow bridge or reducer gap shown by the failure. Do not change the persistence strategy.

- [ ] **Step 4: Run integration guard tests and verify green**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts apps/ohbaby-web/src/api/daemon/server-client.integration.test.ts -t "reasoning"
```

Expected: PASS.

### Task 8: Full Verification And Commit

**Files:**
- Modify only files already touched by Tasks 1-7.

- [ ] **Step 1: Run focused reasoning suite**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts packages/ohbaby-agent/src/core/context/serializer.integration.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/stream-bridge-run-event-source.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts apps/ohbaby-web/src/api/daemon/eventReducer.unit.test.ts apps/ohbaby-web/src/ui/App.unit.test.tsx packages/ohbaby-cli/src/tui/app.contract.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run project gates**

Run:

```bash
pnpm run typecheck
pnpm run lint
pnpm test -- --runInBand
```

Expected: PASS. If `--runInBand` is unsupported by Vitest in this repo, run `pnpm test` instead and record the reason.

- [ ] **Step 3: Run available e2e**

Run:

```bash
pnpm vitest run --config vitest.e2e.config.ts --passWithNoTests
```

Expected: PASS or documented environment-only failure.

- [ ] **Step 4: Review diff for scope**

Run:

```bash
git diff --stat
git diff --check
git status --short
```

Expected: No whitespace errors. Untracked `docs/problem-lists/2026-06-24-reasoning-display/` remains untouched unless the user asks to include it.

- [ ] **Step 5: Commit implementation**

Run:

```bash
git add packages apps docs/superpowers/plans/2026-06-24-reasoning-display-context.md
git commit -m "feat: stream reasoning without persisting context"
```

Expected: Commit succeeds.
