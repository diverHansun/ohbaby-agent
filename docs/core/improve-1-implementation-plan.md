# Context and Lifecycle Improve-1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-home turn preparation in `core/context`, add a session-driven lifecycle loop, and upgrade compaction correctness without breaking existing `compact + assemble + run` callers.

**Architecture:** `core/message` remains the only persisted conversation source. `core/context.prepareTurn` becomes the only path that turns persisted messages, system prompt, and memory into provider-ready `ChatCompletionMessage[]`. `core/lifecycle.runSession` asks context for each turn instead of keeping a local conversation copy, while the existing `run()` entry stays untouched for improve-1 compatibility.

**Tech Stack:** TypeScript, Vitest, pnpm workspace scripts, OpenAI-compatible `ChatCompletionMessage` types, existing `MessageManager`, `ContextManager`, `Lifecycle`, `ToolScheduler`, and Bus primitives.

---

## Implementation Order

Use this order rather than the phase order in only one subdocument:

1. Align internal context helpers first: filters, summary detection, and protocol-aware serialization.
2. Add `prepareTurn` and its events while keeping old context APIs stable.
3. Upgrade compaction algorithms: prompt, file ops, provider-usage token anchor, cut points, and absolute reserve threshold.
4. Add `runSession` after `prepareTurn` is stable.
5. Update docs, changelog, and run the full verification set.

Two planning corrections are intentional:

- `estimateContextTokens(history)` belongs in `packages/ohbaby-agent/src/core/context/token-estimation.ts`, not `services/llm-model`, because it consumes `MessageWithParts` and `Part`.
- `prepareTurn` must not call the current `messageManager.toModelMessages()` as-is. That converter flattens tool parts into assistant text, while `runSession` needs context to reconstruct valid `assistant(tool_calls) + tool` protocol messages from persisted `ToolPart` records.

---

### Task 1: Centralize Active-Part and Summary Predicates

**Files:**
- Create: `packages/ohbaby-agent/src/core/context/filters.ts`
- Create: `packages/ohbaby-agent/src/core/context/summary.ts`
- Modify: `packages/ohbaby-agent/src/core/context/serialization.ts`
- Modify: `packages/ohbaby-agent/src/core/context/context-manager.ts`
- Test: `packages/ohbaby-agent/src/core/context/manager.unit.test.ts`

- [ ] **Step 1: Write failing predicate tests**

Add tests that prove compacted parts are filtered by one predicate and summary messages are partitioned consistently:

```ts
it("partitions context summary messages before active non-summary history", async () => {
  const messageManager = createMessageManagerFixture();
  const summary = await messageManager.createMessage({
    sessionId: "session_1",
    role: "assistant",
    agent: "context",
  });
  await messageManager.appendPart(summary.id, {
    type: "text",
    text: "summary",
    synthetic: true,
    metadata: { kind: "context-summary" },
  });
  await addTextMessage(messageManager, {
    sessionId: "session_1",
    role: "user",
    text: "latest",
  });

  const { manager } = createManager({ messageManager });
  const context = await manager.assemble("session_1", "D:/repo");

  expect(context.history.map((message) => message.info.id)).toEqual([
    summary.id,
    "message_2",
  ]);
});
```

- [ ] **Step 2: Run the targeted test and verify it fails**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts -t "partitions context summary"`

Expected: FAIL because the new helper modules do not exist yet.

- [ ] **Step 3: Add helpers and route existing code through them**

Implement:

```ts
// packages/ohbaby-agent/src/core/context/filters.ts
import type { Part } from "../message/index.js";

export function isActivePart(part: Part): boolean {
  return part.time?.compacted === undefined;
}
```

```ts
// packages/ohbaby-agent/src/core/context/summary.ts
import type { MessageWithParts } from "../message/index.js";

export function isSummaryMessage(message: MessageWithParts): boolean {
  return message.parts.some(
    (part) =>
      part.type === "text" && part.metadata?.kind === "context-summary",
  );
}

export function partitionSummary(history: readonly MessageWithParts[]): {
  readonly summaries: readonly MessageWithParts[];
  readonly nonSummary: readonly MessageWithParts[];
} {
  return {
    summaries: history.filter(isSummaryMessage),
    nonSummary: history.filter((message) => !isSummaryMessage(message)),
  };
}
```

Update `serialization.ts` so `serializePart` calls `isActivePart(part)` and `isContextSummary` forwards to `isSummaryMessage`.

- [ ] **Step 4: Run the context unit suite**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ohbaby-agent/src/core/context/filters.ts packages/ohbaby-agent/src/core/context/summary.ts packages/ohbaby-agent/src/core/context/serialization.ts packages/ohbaby-agent/src/core/context/context-manager.ts packages/ohbaby-agent/src/core/context/manager.unit.test.ts
git commit -m "refactor: centralize context filtering helpers"
```

---

### Task 2: Add Protocol-Aware Context Serializer

**Files:**
- Create: `packages/ohbaby-agent/src/core/context/serializer.ts`
- Modify: `packages/ohbaby-agent/src/core/context/index.ts`
- Test: `packages/ohbaby-agent/src/core/context/manager.unit.test.ts`

- [ ] **Step 1: Write failing serializer tests**

Cover system + memory assembly and persisted tool protocol reconstruction:

```ts
it("serializes tool parts as assistant tool calls followed by tool results", async () => {
  const messageManager = createMessageManagerFixture();
  const user = await messageManager.createMessage({
    sessionId: "session_1",
    role: "user",
    agent: "test",
  });
  await messageManager.appendPart(user.id, { type: "text", text: "read file" });
  const assistant = await messageManager.createMessage({
    sessionId: "session_1",
    role: "assistant",
    agent: "test",
  });
  await messageManager.appendPart(assistant.id, {
    type: "tool",
    callId: "call_read",
    tool: "read_file",
    state: {
      status: "completed",
      input: { path: "README.md" },
      output: "content",
    },
  });

  const { manager } = createManager({ messageManager });
  const context = await manager.assemble("session_1", "D:/repo");
  const messages = serializeForLlm({
    history: context.history,
    isSubagent: false,
    memory: { global: "", project: "", merged: "" },
    systemPrompt: "system prompt",
  });

  expect(messages).toEqual([
    { role: "system", content: "system prompt" },
    { role: "user", content: "read file" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_read",
          type: "function",
          function: {
            name: "read_file",
            arguments: "{\"path\":\"README.md\"}",
          },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_read", content: "content" },
  ]);
});
```

- [ ] **Step 2: Run the targeted serializer test and verify it fails**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts -t "serializes tool parts"`

Expected: FAIL because `serializeForLlm` is not implemented/exported.

- [ ] **Step 3: Implement `serializeForLlm`**

Implement these rules:

```ts
export function serializeForLlm(input: {
  readonly systemPrompt: string;
  readonly memory: MergedMemory;
  readonly history: readonly MessageWithParts[];
  readonly isSubagent: boolean;
  readonly onSecurityFinding?: (finding: PromptSecurityFinding) => void;
}): ChatCompletionMessage[] {
  const systemPrompt = input.isSubagent
    ? input.systemPrompt
    : appendMemoryToSystemPrompt(
        input.systemPrompt,
        loadMemoryForPrompt(input.memory.merged, input.onSecurityFinding),
      );
  const messages = [
    ...(systemPrompt.trim() === ""
      ? []
      : [{ role: "system" as const, content: systemPrompt }]),
    ...serializeHistoryMessages(input.history),
  ];
  return messages;
}
```

`serializeHistoryMessages` must:

- emit user/system text messages as content messages;
- emit assistant text/reasoning content as assistant content when no tool part exists;
- emit assistant tool parts as one assistant message with `tool_calls`;
- emit one `tool` message per completed/error/aborted tool part, preserving source order;
- omit compacted parts and pending/running tool result messages from LLM input.

- [ ] **Step 4: Keep adapter memory helpers as wrappers**

Move the memory logic from `adapters/ui-runtime/prompt-context.ts` into `serializer.ts`, then re-export wrapper functions from the adapter file so existing imports still work.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ohbaby-agent/src/core/context/serializer.ts packages/ohbaby-agent/src/core/context/index.ts packages/ohbaby-agent/src/core/context/manager.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/prompt-context.ts
git commit -m "feat: add protocol-aware context serializer"
```

---

### Task 3: Add `ContextManager.prepareTurn`

**Files:**
- Modify: `packages/ohbaby-agent/src/core/context/types.ts`
- Modify: `packages/ohbaby-agent/src/core/context/context-manager.ts`
- Modify: `packages/ohbaby-agent/src/core/context/events.ts`
- Modify: `packages/ohbaby-agent/src/core/context/index.ts`
- Test: `packages/ohbaby-agent/src/core/context/manager.unit.test.ts`

- [ ] **Step 1: Write failing `prepareTurn` tests**

Add coverage for the stable contract:

```ts
it("prepareTurn returns provider-ready messages without mutating below threshold", async () => {
  const messageManager = createMessageManagerFixture();
  await addTextMessage(messageManager, {
    sessionId: "session_1",
    role: "user",
    text: "hello",
  });
  const { manager } = createManager({ messageManager });

  const prepared = await manager.prepareTurn({
    directory: "D:/repo",
    modelId: "model-a",
    sessionId: "session_1",
  });

  expect(prepared.messages[0]).toEqual({
    role: "system",
    content: expect.stringContaining("system prompt"),
  });
  expect(prepared.compaction).toBeUndefined();
  expect(prepared.usage.shouldCompress).toBe(false);
  expect(prepared.hasSummary).toBe(false);
});
```

- [ ] **Step 2: Run targeted test and verify it fails**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts -t "prepareTurn returns"`

Expected: FAIL because `prepareTurn` is not on `ContextManager`.

- [ ] **Step 3: Add types and decision function**

Add:

```ts
export interface PrepareTurnInput {
  readonly sessionId: string;
  readonly directory: string;
  readonly modelId: string;
  readonly isSubagent?: boolean;
  readonly force?: boolean;
}

export interface PreparedTurn {
  readonly messages: readonly ChatCompletionMessage[];
  readonly usage: ContextUsage;
  readonly compaction?: CompactResult;
  readonly assembledAt: number;
  readonly hasSummary: boolean;
}

export type CompactAction = "skip" | "prune-only" | "compact";

export function decideCompactAction(input: {
  readonly force: boolean;
  readonly historyLength: number;
  readonly usage: ContextUsage;
}): CompactAction {
  if (input.force) return "compact";
  if (!input.usage.shouldCompress) return "skip";
  if (input.historyLength <= 2) return "prune-only";
  return "compact";
}
```

- [ ] **Step 4: Implement `prepareTurn`**

Use one `assemble` call for the common path:

```ts
async function prepareTurn(input: PrepareTurnInput): Promise<PreparedTurn> {
  const startedAt = now();
  const assembled = await assemble(
    input.sessionId,
    input.directory,
    input.isSubagent ?? false,
  );
  const usageBefore = getContextUsage(
    assembled,
    input.modelId,
    options.tokenCounter,
    compressionThreshold,
  );
  const action = decideCompactAction({
    force: input.force === true,
    historyLength: assembled.history.length,
    usage: usageBefore,
  });
  const compaction =
    action === "skip"
      ? undefined
      : await compact(input.sessionId, {
          directory: input.directory,
          force: action === "compact" || input.force === true,
          isSubagent: input.isSubagent,
          modelId: input.modelId,
        });
  const finalContext =
    compaction === undefined
      ? assembled
      : await assemble(input.sessionId, input.directory, input.isSubagent ?? false);
  const usage = getContextUsage(
    finalContext,
    input.modelId,
    options.tokenCounter,
    compressionThreshold,
  );
  const messages = serializeForLlm({
    history: finalContext.history,
    isSubagent: input.isSubagent ?? false,
    memory: finalContext.memory,
    systemPrompt: finalContext.systemPrompt,
  });
  options.bus.publish(ContextEvent.TurnPrepared, {
    sessionId: input.sessionId,
    tookMs: Math.max(0, now() - startedAt),
    triggeredCompaction: compaction !== undefined && compaction.status !== "not-needed",
    usage,
  });
  return {
    assembledAt: finalContext.assembledAt,
    compaction,
    hasSummary: finalContext.hasSummary,
    messages,
    usage,
  };
}
```

This minimal version may call `assemble` twice on compaction paths. Keep the public behavior correct first; optimize the compaction path after tests are green.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts`

Run: `pnpm --filter ohbaby-agent typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ohbaby-agent/src/core/context/types.ts packages/ohbaby-agent/src/core/context/context-manager.ts packages/ohbaby-agent/src/core/context/events.ts packages/ohbaby-agent/src/core/context/index.ts packages/ohbaby-agent/src/core/context/manager.unit.test.ts
git commit -m "feat: add context prepareTurn contract"
```

---

### Task 4: Upgrade Summary Prompt and Summary Client Contract

**Files:**
- Modify: `packages/ohbaby-agent/src/core/context/compression-prompt.ts`
- Modify: `packages/ohbaby-agent/src/core/context/types.ts`
- Modify: `packages/ohbaby-agent/src/core/context/context-manager.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-runtime/prompt-context.ts`
- Test: `packages/ohbaby-agent/src/core/context/manager.unit.test.ts`

- [ ] **Step 1: Write failing prompt tests**

```ts
it("passes the structured summarization system prompt to the summary client", async () => {
  const generateSummary = vi.fn().mockResolvedValue("## Goal\nshort");
  const messageManager = createMessageManagerFixture();
  await addTextMessage(messageManager, { sessionId: "session_1", role: "user", text: "one long text" });
  await addTextMessage(messageManager, { sessionId: "session_1", role: "assistant", text: "two long text" });
  await addTextMessage(messageManager, { sessionId: "session_1", role: "user", text: "three long text" });
  const { manager } = createManager({ llmClient: { generateSummary }, messageManager });

  await manager.compress("session_1", true);

  expect(generateSummary).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: expect.stringContaining("## Goal"),
      systemPrompt: expect.stringContaining("context summarization assistant"),
    }),
  );
});
```

- [ ] **Step 2: Run targeted test and verify it fails**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts -t "structured summarization"`

Expected: FAIL because `systemPrompt` is not accepted/passed.

- [ ] **Step 3: Replace XML summary prompt with six-section Markdown**

Export:

```ts
export const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant. Read the conversation and output only the requested structured summary.";

export const COMPRESSION_PROMPT = `The messages above are conversation history to summarize. Create a concise context checkpoint another coding agent can use to continue.

Use this exact format:

## Goal
[What the user is trying to accomplish.]

## Constraints & Preferences
- [Requirements, preferences, or "(none)".]

## Progress
### Done
- [Completed work.]
### In Progress
- [Current work.]
### Blocked
- [Blockers or "(none)".]

## Key Decisions
- **[Decision]**: [Reason.]

## Next Steps
1. [Next action.]

## Critical Context
- [Exact file paths, APIs, commands, errors, or assumptions needed to continue.]

Keep each section concise. Preserve exact file paths, function names, command names, and error messages.`;
```

- [ ] **Step 4: Extend `ContextLLMClient.generateSummary` input**

Add optional `systemPrompt?: string` and pass it from `summarizeActiveHistory`. Update `createContextSummaryClient` to send `{ role: "system", content: input.systemPrompt ?? input.prompt }` and `{ role: "user", content: ... }`.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ohbaby-agent/src/core/context/compression-prompt.ts packages/ohbaby-agent/src/core/context/types.ts packages/ohbaby-agent/src/core/context/context-manager.ts packages/ohbaby-agent/src/adapters/ui-runtime/prompt-context.ts packages/ohbaby-agent/src/core/context/manager.unit.test.ts
git commit -m "feat: improve context summary prompt"
```

---

### Task 5: Add File Operation Tracking to Summaries

**Files:**
- Create: `packages/ohbaby-agent/src/core/context/file-ops.ts`
- Modify: `packages/ohbaby-agent/src/core/context/context-manager.ts`
- Test: `packages/ohbaby-agent/src/core/context/manager.unit.test.ts`

- [ ] **Step 1: Write failing file-op extraction tests**

```ts
it("appends compressed read and modified file paths to the summary", async () => {
  const messageManager = createMessageManagerFixture();
  const assistant = await messageManager.createMessage({
    sessionId: "session_1",
    role: "assistant",
    agent: "test",
  });
  await messageManager.appendPart(assistant.id, {
    type: "tool",
    callId: "call_read",
    tool: "read_file",
    state: { status: "completed", input: { path: "src/a.ts" }, output: "a" },
  });
  await messageManager.appendPart(assistant.id, {
    type: "tool",
    callId: "call_edit",
    tool: "edit_file",
    state: { status: "completed", input: { file_path: "src/b.ts" }, output: "b" },
  });
  await addTextMessage(messageManager, { sessionId: "session_1", role: "user", text: "continue" });
  const { manager } = createManager({
    llmClient: { generateSummary: vi.fn().mockResolvedValue("## Goal\nshort") },
    messageManager,
  });

  await manager.compress("session_1", true);
  const history = await messageManager.listBySession("session_1");
  const summaryText = history.at(-1)?.parts[0]?.type === "text" ? history.at(-1)?.parts[0]?.text : "";

  expect(summaryText).toContain("<read-files>\n- src/a.ts\n</read-files>");
  expect(summaryText).toContain("<modified-files>\n- src/b.ts\n</modified-files>");
});
```

- [ ] **Step 2: Run targeted test and verify it fails**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts -t "appends compressed read"`

Expected: FAIL because no file-op tracking exists.

- [ ] **Step 3: Implement extraction and formatting**

```ts
export interface FileOpsExtract {
  readonly read: readonly string[];
  readonly modified: readonly string[];
}

export function extractFileOps(history: readonly MessageWithParts[]): FileOpsExtract {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const message of history) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const path = pathFromInput(part.state.input);
      if (!path) continue;
      if (["read", "read_file", "view", "cat"].includes(part.tool)) read.add(path);
      if (["write", "write_file", "edit", "edit_file", "apply_patch", "str_replace"].includes(part.tool)) modified.add(path);
    }
  }
  return { read: [...read].sort(), modified: [...modified].sort() };
}
```

Append formatted blocks only when a set is non-empty.

- [ ] **Step 4: Run context tests**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ohbaby-agent/src/core/context/file-ops.ts packages/ohbaby-agent/src/core/context/context-manager.ts packages/ohbaby-agent/src/core/context/manager.unit.test.ts
git commit -m "feat: track compressed file operations"
```

---

### Task 6: Add Provider-Usage Token Anchor

**Files:**
- Create: `packages/ohbaby-agent/src/core/context/token-estimation.ts`
- Modify: `packages/ohbaby-agent/src/core/message/types.ts`
- Modify: `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts`
- Modify: `packages/ohbaby-agent/src/core/context/context-manager.ts`
- Test: `packages/ohbaby-agent/src/core/context/manager.unit.test.ts`
- Test: `packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts`

- [ ] **Step 1: Write failing token estimation tests**

```ts
function messageWithText(
  role: "user" | "assistant",
  text: string,
  metadata?: Record<string, unknown>,
): MessageWithParts {
  return {
    info: {
      agent: "test",
      id: `${role}_${text}`,
      role,
      sessionId: "session_1",
      time: { created: 1 },
    },
    parts: [
      {
        id: `part_${role}_${text}`,
        messageId: `${role}_${text}`,
        metadata,
        orderIndex: 0,
        sessionId: "session_1",
        text,
        type: "text",
      },
    ],
  };
}

it("estimates context tokens from the latest provider usage anchor plus tail", () => {
  const history = [
    messageWithText("user", "old user"),
    messageWithText("assistant", "old assistant", {
      tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    }),
    messageWithText("user", "tail"),
  ];

  expect(estimateContextTokens(history, { estimateTokens: (text) => text.length })).toEqual({
    anchorIndex: 1,
    anchorTokens: 120,
    tailTokens: "user: tail".length,
    tokens: 120 + "user: tail".length,
  });
});
```

- [ ] **Step 2: Run targeted test and verify it fails**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts -t "provider usage anchor"`

Expected: FAIL because `token-estimation.ts` does not exist.

- [ ] **Step 3: Add metadata type and estimator**

Use an explicit metadata shape while keeping `Record<string, unknown>` compatibility:

```ts
export interface TokenUsageMetadata {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}
```

`estimateContextTokens` should find the last part metadata object with `tokenUsage`, return `totalTokens` for the anchor, and estimate only messages after that anchor with the existing token counter.

- [ ] **Step 4: Persist token usage on assistant completion**

In `runModelStep`, when updating the assistant message after `finalEvent`, also update the assistant text part metadata when present:

```ts
if (assistantTextPart && finalEvent.tokenUsage) {
  await this.deps.messageManager.updatePart(assistantTextPart.id, {
    metadata: {
      ...assistantTextPart.metadata,
      tokenUsage: {
        promptTokens: finalEvent.tokenUsage.prompt_tokens,
        completionTokens: finalEvent.tokenUsage.completion_tokens,
        totalTokens: finalEvent.tokenUsage.total_tokens,
      },
    },
  });
}
```

- [ ] **Step 5: Wire estimator into context usage**

Use `estimateContextTokens(history, options.tokenCounter).tokens` in `assemble` instead of serializing the full system + memory + history as one text blob. Add system prompt and memory token estimates separately so the provider anchor applies only to conversation history.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts`

Run: `pnpm --filter ohbaby-agent typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/ohbaby-agent/src/core/context/token-estimation.ts packages/ohbaby-agent/src/core/message/types.ts packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts packages/ohbaby-agent/src/core/context/context-manager.ts packages/ohbaby-agent/src/core/context/manager.unit.test.ts packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts
git commit -m "feat: anchor context token estimates to provider usage"
```

---

### Task 7: Add Smart Cut Points and Absolute Reserve Threshold

**Files:**
- Modify: `packages/ohbaby-agent/src/core/context/constants.ts`
- Modify: `packages/ohbaby-agent/src/core/context/context-manager.ts`
- Test: `packages/ohbaby-agent/src/core/context/manager.unit.test.ts`

- [ ] **Step 1: Write failing cut-point tests**

```ts
function textMessage(
  role: "user" | "assistant",
  text: string,
  index: number,
): MessageWithParts {
  return {
    info: {
      agent: "test",
      id: `message_${String(index)}`,
      role,
      sessionId: "session_1",
      time: { created: index },
    },
    parts: [
      {
        id: `part_${String(index)}`,
        messageId: `message_${String(index)}`,
        orderIndex: 0,
        sessionId: "session_1",
        text,
        type: "text",
      },
    ],
  };
}

function assistantToolMessage(input: {
  readonly callId: string;
  readonly input: Record<string, unknown>;
  readonly output: string;
  readonly tool: string;
}): MessageWithParts {
  return {
    info: {
      agent: "test",
      id: "message_tool",
      role: "assistant",
      sessionId: "session_1",
      time: { created: 2 },
    },
    parts: [
      {
        callId: input.callId,
        id: "part_tool",
        messageId: "message_tool",
        orderIndex: 0,
        sessionId: "session_1",
        state: {
          input: input.input,
          output: input.output,
          status: "completed",
        },
        tool: input.tool,
        type: "tool",
      },
    ],
  };
}

it("does not cut between assistant tool calls and their tool result messages", async () => {
  const history = [
    textMessage("user", "start", 1),
    assistantToolMessage({
      callId: "call_1",
      input: { path: "README.md" },
      output: "large output",
      tool: "read_file",
    }),
    textMessage("user", "recent", 3),
  ];

  const cut = findCutPoint({
    history,
    keepRecentTokens: 5,
    tokenCounter: { estimateTokens: (text) => text.length, getLimit: () => 100 },
  });

  expect(cut.firstKeptIndex).not.toBe(1);
});
```

- [ ] **Step 2: Run targeted test and verify it fails**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts -t "does not cut"`

Expected: FAIL because cut-point helpers are not implemented/exported for tests.

- [ ] **Step 3: Add constants**

```ts
export const KEEP_RECENT_TOKENS = 20_000;
export const COMPACTION_RESERVE_TOKENS = 16_384;
```

- [ ] **Step 4: Implement cut-point helpers**

Rules:

- legal cut points are message boundaries before user messages and assistant messages;
- never cut inside a message;
- because persisted tool results are `ToolPart` records on assistant messages, keeping message boundaries also preserves assistant tool-call/result pairing;
- return `turnPrefixMessages` when the selected boundary keeps the suffix of a multi-message turn; summarize that prefix separately before the normal compressed range;
- for a single oversized assistant message that contains `ToolPart` call/result state, compact the whole message or keep the whole message; do not split inside the `ToolPart` in improve-1.

- [ ] **Step 5: Switch compression threshold to absolute reserve when budget exists**

In `getContextUsage`, set:

```ts
shouldCompress:
  budget.remainingInputTokens < COMPACTION_RESERVE_TOKENS
```

Keep the current `usageRatio >= compressionThreshold` fallback when `getBudget` is unavailable.

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/ohbaby-agent/src/core/context/constants.ts packages/ohbaby-agent/src/core/context/context-manager.ts packages/ohbaby-agent/src/core/context/manager.unit.test.ts
git commit -m "feat: improve context compaction cut points"
```

---

### Task 8: Add `Lifecycle.runSession`

**Files:**
- Modify: `packages/ohbaby-agent/src/core/lifecycle/types.ts`
- Modify: `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts`
- Modify: `packages/ohbaby-agent/src/core/lifecycle/index.ts`
- Test: `packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts`

- [ ] **Step 1: Write failing `runSession` tests**

```ts
const fakeUsage = {
  contextLimit: 100,
  currentTokens: 10,
  modelId: "fake-model",
  remainingTokens: 90,
  shouldCompress: false,
  usageRatio: 0.1,
} satisfies ContextUsage;

function createFakeContextManager(): ContextManager & {
  readonly prepareTurn: ReturnType<typeof vi.fn>;
} {
  return {
    assemble: vi.fn(),
    compact: vi.fn(),
    compress: vi.fn(),
    getUsage: vi.fn(),
    prepareTurn: vi.fn(),
    prune: vi.fn(),
    shouldCompress: vi.fn(),
  } as unknown as ContextManager & {
    readonly prepareTurn: ReturnType<typeof vi.fn>;
  };
}

function toolCallEvent(callId: string): ProviderStreamEvent {
  return {
    finishReason: "tool_calls",
    toolCallDeltas: [
      {
        argumentsDelta: "{\"path\":\"README.md\"}",
        id: callId,
        index: 0,
        name: "read_file",
      },
    ],
  };
}

function successfulToolScheduler(
  callId: string,
  output: string,
): ToolSchedulerInstance {
  return {
    executeBatch: vi.fn().mockResolvedValue([
      {
        callId,
        output,
        status: "success",
      },
    ]),
  } as unknown as ToolSchedulerInstance;
}

it("runSession asks context for every model turn and sees messages appended between turns", async () => {
  const requests: ProviderRequest[] = [];
  const contextManager = createFakeContextManager();
  const messageManager = createMessageManager({
    bus: createBus(),
    store: createInMemoryMessageStore(),
    idGenerator: createDeterministicIds(),
    now: () => 1_700_000_000_000,
  });
  contextManager.prepareTurn.mockImplementation(async () => ({
    assembledAt: Date.now(),
    hasSummary: false,
    messages: await messageManager.toModelMessages("session_test"),
    usage: fakeUsage,
  }));
  const lifecycle = new Lifecycle({
    contextManager,
    llmClient: createSequentialFakeLLMClient(
      [[toolCallEvent("call_read")], [{ textDelta: "done", finishReason: "stop" }]],
      requests,
    ),
    messageManager,
    toolScheduler: successfulToolScheduler("call_read", "content"),
  });

  const result = await consumeLifecycle(lifecycle.runSession({
    directory: "D:/repo",
    modelId: "fake-model",
    sessionId: "session_test",
  }));

  expect(contextManager.prepareTurn).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ success: true, finalResponse: "done" });
});
```

- [ ] **Step 2: Run targeted test and verify it fails**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts -t "runSession asks context"`

Expected: FAIL because `runSession` and `contextManager` dependency do not exist.

- [ ] **Step 3: Add types**

Add `LifecycleSessionParams`, `LifecycleConfig`, `TurnContext`, `ToolCallContext`, `BeforeToolCallResult`, and `AfterToolCallResult`. Keep `messageManager` and `toolScheduler` optional in `LifecycleDeps` until every existing test/caller is audited; require them at runtime only inside `runSession`.

- [ ] **Step 4: Implement `runSession` using shared helpers**

Behavior:

- call `contextManager.prepareTurn` at the top of each step;
- yield `turn:start` with `prepared.usage`;
- stream LLM using `prepared.messages`;
- persist assistant and tool parts through `messageManager`;
- execute tools through `toolScheduler.executeBatch`;
- yield `turn:end`;
- call `config.shouldStopAfterTurn` after tool results and before the next step;
- do not mutate a `conversationMessages` local array in `runSession`.

- [ ] **Step 5: Preserve old `run()` behavior**

Do not remove `toAssistantToolMessage`, `toolResultToMessage`, or the current `conversationMessages` logic yet, because old `run()` still depends on it during improve-1.

- [ ] **Step 6: Run lifecycle tests and typecheck**

Run: `pnpm vitest run packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts`

Run: `pnpm --filter ohbaby-agent typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/ohbaby-agent/src/core/lifecycle/types.ts packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts packages/ohbaby-agent/src/core/lifecycle/index.ts packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts
git commit -m "feat: add session-driven lifecycle loop"
```

---

### Task 9: Documentation, Changelog, and Verification

**Files:**
- Modify: `packages/ohbaby-agent/CHANGELOG.md`
- Modify: `docs/core/context/architecture.md`
- Modify: `docs/core/context/data-model.md`
- Modify: `docs/core/context/dfd-interface.md`
- Modify: `docs/core/lifecycle/architecture.md`
- Modify: `docs/core/lifecycle/data-model.md`
- Modify: `docs/core/lifecycle/dfd-interface.md`

- [ ] **Step 1: Update public API notes**

Record:

- `ContextManager.prepareTurn`
- `PrepareTurnInput` / `PreparedTurn`
- `Lifecycle.runSession`
- `LifecycleSessionParams` / `LifecycleConfig`
- `ContextEvent.TurnPrepared` / `ContextEvent.CompactSkipped`
- `KEEP_RECENT_TOKENS` / `COMPACTION_RESERVE_TOKENS`
- `SUMMARIZATION_SYSTEM_PROMPT`

- [ ] **Step 2: Run focused verification**

Run:

```bash
pnpm vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts
pnpm --filter ohbaby-agent typecheck
```

Expected: PASS.

- [ ] **Step 3: Run package verification**

Run:

```bash
pnpm --filter ohbaby-agent test
pnpm --filter ohbaby-agent lint
```

Expected: PASS.

- [ ] **Step 4: Run workspace verification before PR/merge**

Run:

```bash
pnpm run typecheck
pnpm run test
pnpm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ohbaby-agent/CHANGELOG.md docs/core/context/architecture.md docs/core/context/data-model.md docs/core/context/dfd-interface.md docs/core/lifecycle/architecture.md docs/core/lifecycle/data-model.md docs/core/lifecycle/dfd-interface.md
git commit -m "docs: document context lifecycle improve one"
```

---

## Self-Review Notes

- Spec coverage: covers context `prepareTurn`, protocol serialization, smart compaction, token anchor, file operations, lifecycle `runSession`, events, docs, and verification.
- Scope guard: does not switch `RunWorker` or `composition.ts` to `runSession`; that remains improve-2.
- Provider guard: keeps `services/llm-model` free of `MessageWithParts` and `Part` imports.
- Risk callout: split-turn is implemented at message-boundary granularity. Part-level splitting is deliberately not forced in improve-1 because ohbaby persists tool call and result state in one `ToolPart`.
