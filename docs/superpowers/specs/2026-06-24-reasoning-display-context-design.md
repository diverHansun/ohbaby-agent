# Reasoning Display And Context Handling Design

> Date: 2026-06-24
> Status: approved for implementation planning
> Source discussion: `docs/problem-lists/2026-06-24-reasoning-display/`

## Goal

OpenAI-compatible providers may stream model reasoning through
`delta.reasoning_content` or `delta.reasoning`. The project already preserves
that data at the provider boundary, but the core streaming layer currently
drops pure reasoning deltas before CLI or web UI can render them.

This design makes reasoning visible during the active run while preserving these
hard boundaries:

- Reasoning is live UI data, not a persisted message part.
- Reasoning is never written to sqlite.
- Reasoning is not included in cross-turn model context.
- Reasoning is passed back only inside the current active tool loop when an
  assistant message has tool calls and a compatible provider requires
  `reasoning_content`.
- Models that do not emit reasoning keep the same behavior as today.

## Chosen Approach

Use the B+ approach from the problem-list docs, with two refinements:

1. Reasoning lifecycle and UI events carry the assistant `messageId` so each
   client can bind live reasoning to the correct streaming assistant message
   without guessing from `sessionId` and `step`.
2. Web and CLI keep reasoning in transient UI state. They may display and fold it
   during the active run, but they do not write it into `UiSnapshot.messages`
   parts. Reloading a session does not restore historical reasoning.

Rejected alternatives:

- Persisting `reasoning` as a normal `Part`: this would write CoT to sqlite and
  existing serializers would currently feed it back to future model requests.
- Pure live display without same-turn passback: this is simpler but breaks
  DeepSeek-style thinking models when a reasoning assistant message also calls
  tools and the next request omits `reasoning_content`.

## Data Flow

```text
openai-compatible provider
  reasoning_content/reasoning -> InterfaceProviderStreamEvent.reasoningDelta
    |
    v
llm-client streaming
  accumulate reasoning separately from content
  yield reasoningDelta and accumulated reasoning
  never add reasoning to completeMessage.content
    |
    v
lifecycle runModelStep
  create assistant message
  emit llm:reasoning-delta / llm:reasoning-end with messageId
  keep current-turn reasoning in memory by assistant message id
  never append a reasoning part
    |
    +--> CLI/web live UI events
    |      render open reasoning while streaming
    |      fold after content begins, reasoning ends, or run completes
    |      no snapshot/sqlite persistence
    |
    v
context prepareTurn inside same run
  serialize history normally
  inject reasoning_content only for current-turn assistant messages
  that have tool_calls and a matching reasoning entry
```

## Core Changes

### Provider And Streaming

`openai-compatible` already extracts `reasoning_content` and `reasoning` as
`reasoningDelta`. No behavior change is needed there except keeping request
messages permissive enough to pass through `reasoning_content` on assistant
messages.

`StreamingResponse` gains:

- `reasoningDelta?: string` for the latest reasoning chunk.
- `reasoning?: string` for reasoning accumulated in the current model step.

`streamChatCompletion` accumulates reasoning separately from text and tool call
fragments. It must remove the current pure-reasoning `continue`, while keeping
these invariants:

- Reasoning does not change `accumulatedContent`.
- Reasoning does not change `completeMessage.content`.
- Pure reasoning chunks still produce a streaming response.

### Lifecycle

`LifecycleEvent` gains:

- `llm:reasoning-delta`
  - `sessionId`
  - `messageId`
  - `step`
  - `delta`
  - `content`
  - `timestamp`
- `llm:reasoning-end`
  - `sessionId`
  - `messageId`
  - `step`
  - `content`
  - `timestamp`

`runModelStep` emits reasoning delta events when `StreamingResponse.reasoningDelta`
is present. It emits a reasoning end event once per step when reasoning was seen
and either text begins, the model step completes, or the step exits through an
error/abort cleanup path.

The lifecycle owns a current-turn map:

```ts
Map<assistantMessageId, string>
```

Each step stores accumulated reasoning under that step's assistant message id.
The map is passed into `contextManager.prepareTurn` for subsequent steps in the
same lifecycle run. It is not persisted and is dropped when the run returns or
throws.

### Context Serialization

`PrepareTurnInput` accepts:

```ts
activeReasoningByMessageId?: ReadonlyMap<string, string>
```

`serializeForLlm` accepts the same map and passes it to assistant serialization.
When an assistant message has completed tool parts and its message id exists in
the map, the serialized assistant message with `tool_calls` receives:

```ts
reasoning_content: reasoningText
```

No other serialized message receives reasoning:

- Assistant messages without tool calls do not get `reasoning_content`.
- Historical assistant messages not present in the current-turn map do not get
  `reasoning_content`.
- Reasoning is never merged into `content`.

Existing `ReasoningPart` types remain for backward compatibility, but model
context serializers stop treating reasoning parts as normal text. This removes
the footgun where a future `appendPart({ type: "reasoning" })` would silently
feed CoT back to the model.

### Runtime And UI Event Bridge

The run stream bridge gains dedicated reasoning events, separate from
`message.part.delta`:

- `message.reasoning.delta`
- `message.reasoning.end`

These are projected into SDK UI events:

- `message.reasoning.delta`
  - `sessionId`
  - `messageId`
  - `delta`
  - `content`
  - `timestamp`
- `message.reasoning.end`
  - `sessionId`
  - `messageId`
  - `content`
  - `timestamp`

They are routed to the active session like existing message events, but reducers
must not store them in `UiSnapshot.messages[].parts`.

### CLI

CLI consumes the new reasoning UI events in its live store. For the active
assistant message:

- append deltas to a transient reasoning block above the assistant text;
- keep the block expanded while reasoning is streaming;
- fold it when `message.reasoning.end`, first normal text delta, or run
  completion arrives;
- do not write the block into persisted transcript/snapshot state.

Legacy `UiMessagePart` values with `type: "reasoning"` may still render for
backward compatibility, but new provider reasoning does not use that path.

### Web

Web keeps a transient reasoning state alongside daemon view state, for example
keyed by `messageId`. This state lives outside `UiSnapshot.sessions[].messages`
and outside `UiMessage.parts`. It renders a `details.ohb-reasoning` block for
the matching streaming assistant message:

- open while receiving reasoning deltas;
- collapsed after end/content/complete;
- manually expandable after folding during the same live run;
- absent after page reload or session snapshot replacement.

The daemon event reducer should acknowledge reasoning events by updating
transient UI state only. It must not mutate `UiSnapshot.messages[].parts`, and
`replaceSnapshot` must clear transient reasoning state.

## Acceptance Criteria

- CLI and web show streaming reasoning for OpenAI-compatible providers that emit
  `reasoning_content` or `reasoning`.
- Reasoning folds automatically after formal content begins or the step/run
  completes.
- No `type = "reasoning"` part is inserted by the lifecycle for provider
  reasoning.
- sqlite remains free of newly generated provider reasoning parts.
- Second and later turns do not contain historical `reasoning_content`.
- Same-turn tool-loop requests include `reasoning_content` only on assistant
  messages with tool calls and matching current-turn reasoning.
- Non-reasoning models produce no reasoning events and keep existing text/tool
  behavior.
- Existing tool streaming, tool result persistence, compaction, and pruning
  behavior remain unchanged.

## Test Plan

- Provider unit tests: both `reasoning_content` and `reasoning` normalize to
  `reasoningDelta`; empty values do not emit reasoning.
- Streaming unit tests: pure reasoning chunks yield responses, accumulate in
  `reasoning`, and do not affect `completeMessage.content`.
- Lifecycle unit tests: reasoning events include `messageId`; no reasoning part
  is appended; reasoning end fires on content/complete/error paths.
- Serializer/context tests: same-turn tool-call assistant messages receive
  `reasoning_content`; messages without tool calls and historical messages do
  not; reasoning parts no longer become model text.
- Persistence integration tests: a reasoning run creates no `reasoning` part row.
- CLI contract tests: reasoning event stream shows live text and then folds.
- Web reducer/component tests: reasoning events update transient UI without
  mutating snapshot message parts.
- Web/server e2e: reasoning events travel through stream bridge, daemon SSE, web
  client, and UI rendering.
- Regression: normal non-reasoning text/tool runs match existing behavior.

## Open Assumptions

- Same-turn reasoning passback can be provider-agnostic. Unknown providers should
  ignore the extra assistant message field or pass it through harmlessly.
- It is acceptable that reconnecting mid-run does not replay already streamed
  reasoning.
- Existing persisted legacy reasoning parts are treated as legacy display data,
  not as future model-context data.
