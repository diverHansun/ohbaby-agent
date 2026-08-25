import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  isContextSummaryPart,
} from "../message/index.js";
import type {
  MessageIdGenerator,
  MessageManager,
  MessageStore,
  MessageWithParts,
  ToolPart,
} from "../message/index.js";
import { createContextManager } from "./context-manager.js";
import { serializeForLlm } from "./serializer.js";
import {
  abortReferenceTools,
  appendReferenceText,
  appendReferenceToolCall,
  applyReferenceCompactionCommit,
  completeReferenceToolCall,
  createReferenceContextState,
  getPendingReferenceCallIds,
  getReferenceMessage,
  observeReferenceUsage,
  projectReferenceHistory,
  recordReferenceCompactionAttempt,
  recordReferenceMessage,
  restartReferenceManager,
  serializeReferenceTrace,
} from "./testing/context-reference-model.js";
import type {
  ReferenceContextState,
  ReferenceToolTerminalStatus,
} from "./testing/context-reference-model.js";
import type { ContextManager, PreparedModelRequest } from "./types.js";
import type { ChatCompletionMessage } from "../llm-client/index.js";

const SESSION_ID = "reference-session";
const DIRECTORY = "/reference-workspace";
const MODEL_ID = "reference-model";
const SYSTEM_PROMPT = "reference system";
const MEMORY = "reference memory";
const ABORTED_RESULT = "Tool execution aborted by user";
const PROPERTY_SEED = 0x4_05_2026;

type RawAction =
  | { readonly type: "startUserTurn"; readonly text: string }
  | { readonly type: "appendAssistantDelta"; readonly text: string }
  | { readonly type: "appendToolCall"; readonly value: number }
  | {
      readonly type: "appendToolResult";
      readonly result: string;
      readonly status: ReferenceToolTerminalStatus;
    }
  | { readonly type: "prepareStep"; readonly tools: readonly ToolName[] }
  | {
      readonly type: "observeUsage";
      readonly inputTokens: number;
      readonly sentHeuristic: number;
    }
  | { readonly type: "autoCompact" }
  | { readonly type: "manualCompact" }
  | { readonly type: "providerOverflow" }
  | { readonly type: "abortRun" }
  | { readonly type: "restartManager" };

type ToolName = "bash" | "read" | "write";

interface PreparedSnapshot {
  readonly request: PreparedModelRequest;
  readonly value: PreparedModelRequest;
}

interface ReferenceHarness {
  currentAssistantId?: string;
  readonly contextScopeId?: string;
  contextManager: ContextManager;
  messageManager: MessageManager;
  readonly preparedSnapshots: PreparedSnapshot[];
  reference: ReferenceContextState;
  readonly rebuildManager: () => void;
  readonly store: MessageStore;
  readonly trace: RawAction[];
}

function createMessageIds(): MessageIdGenerator {
  let nextMessageId = 1;
  let nextPartId = 1;
  return {
    messageId: () => `reference-message-${String(nextMessageId++)}`,
    partId: () => `reference-part-${String(nextPartId++)}`,
  };
}

function createClock(): () => number {
  let current = 1_000;
  return () => {
    current += 1;
    return current;
  };
}

function createHarness(isSubagent: boolean): ReferenceHarness {
  const store = createInMemoryMessageStore();
  const idGenerator = createMessageIds();
  const now = createClock();
  const contextScopeId = isSubagent ? "child-scope" : undefined;
  let rebuildManager = (): void => {
    throw new Error("Reference harness has not been initialized");
  };
  const harness = {
    contextScopeId,
    contextManager: undefined as unknown as ContextManager,
    messageManager: undefined as unknown as MessageManager,
    preparedSnapshots: [],
    reference: createReferenceContextState(),
    rebuildManager: (): void => {
      rebuildManager();
    },
    store,
    trace: [],
  } satisfies ReferenceHarness;

  rebuildManager = (): void => {
    const bus = createBus();
    harness.messageManager = createMessageManager({
      bus,
      idGenerator,
      now,
      store,
    });
    harness.contextManager = createContextManager({
      bus,
      llmClient: {
        generateSummary: () => Promise.resolve("reference-summary"),
      },
      maskEnabled: false,
      memory: {
        load: () =>
          Promise.resolve({
            global: MEMORY,
            merged: MEMORY,
            project: "",
          }),
      },
      messageManager: harness.messageManager,
      now,
      pruneMinimumTokens: Number.MAX_SAFE_INTEGER,
      systemPromptProvider: {
        build: () => Promise.resolve(SYSTEM_PROMPT),
      },
      thrashWindow: 2,
      tokenCounter: {
        estimateTokens: (content) => content.length,
        getLimit: () => 420,
      },
    });
  };

  rebuildManager();
  return harness;
}

function toolsFor(names: readonly ToolName[]): PreparedModelRequest["tools"] {
  return names.map((name) => ({
    function: {
      name,
      parameters: { additionalProperties: true, type: "object" },
    },
    type: "function" as const,
  }));
}

async function applyAction(
  harness: ReferenceHarness,
  action: RawAction,
): Promise<void> {
  harness.trace.push(action);
  switch (action.type) {
    case "startUserTurn": {
      const message = await harness.messageManager.createMessage({
        ...(harness.contextScopeId === undefined
          ? {}
          : { contextScopeId: harness.contextScopeId }),
        agent: "reference",
        role: "user",
        sessionId: SESSION_ID,
      });
      const part = await harness.messageManager.appendPart(message.id, {
        text: action.text,
        type: "text",
      });
      harness.reference = recordReferenceMessage(harness.reference, {
        messageId: message.id,
        partId: part.id,
        role: "user",
        text: action.text,
      });
      harness.currentAssistantId = undefined;
      break;
    }
    case "appendAssistantDelta": {
      await ensureAssistant(harness, action.text);
      break;
    }
    case "appendToolCall": {
      const messageId = await ensureAssistant(harness, "");
      const callId = `reference-call-${String(harness.trace.length)}-${String(action.value)}`;
      const part = await harness.messageManager.appendPart(messageId, {
        callId,
        state: {
          input: { value: action.value },
          raw: JSON.stringify({ value: action.value }),
          status: "pending",
        },
        tool: "read",
        type: "tool",
      });
      harness.reference = appendReferenceToolCall(harness.reference, {
        callId,
        input: { value: action.value },
        messageId,
        partId: part.id,
        tool: "read",
      });
      break;
    }
    case "appendToolResult": {
      const pendingCallIds = getPendingReferenceCallIds(harness.reference);
      if (pendingCallIds.length === 0) {
        harness.trace.pop();
        return;
      }
      const callId = pendingCallIds[0];
      const toolPart = await findToolPart(harness, callId);
      const result =
        action.status === "aborted" ? ABORTED_RESULT : action.result;
      await harness.messageManager.updatePart(toolPart.id, {
        state:
          action.status === "completed"
            ? {
                input: toolPart.state.input,
                output: result,
                status: "completed",
              }
            : action.status === "error"
              ? {
                  error: result,
                  input: toolPart.state.input,
                  status: "error",
                }
              : {
                  error: ABORTED_RESULT,
                  input: toolPart.state.input,
                  status: "aborted",
                },
      });
      harness.reference = completeReferenceToolCall(harness.reference, {
        callId,
        result,
        status: action.status,
      });
      break;
    }
    case "prepareStep": {
      await prepareAndSynchronize(harness, action.tools, false);
      break;
    }
    case "observeUsage": {
      harness.contextManager.updateCalibrationFactor(
        SESSION_ID,
        action.inputTokens,
        action.sentHeuristic,
        harness.contextScopeId,
      );
      harness.reference = observeReferenceUsage(harness.reference);
      break;
    }
    case "autoCompact": {
      harness.reference = recordReferenceCompactionAttempt(harness.reference);
      await harness.contextManager.compact(SESSION_ID, {
        ...(harness.contextScopeId === undefined
          ? {}
          : { contextScopeId: harness.contextScopeId }),
        directory: DIRECTORY,
        force: false,
        isSubagent: harness.contextScopeId !== undefined,
        modelId: MODEL_ID,
        toolNames: [],
        tools: undefined,
      });
      await synchronizeCommittedCompaction(harness);
      harness.currentAssistantId = undefined;
      break;
    }
    case "manualCompact": {
      harness.reference = recordReferenceCompactionAttempt(harness.reference);
      await harness.contextManager.compact(SESSION_ID, {
        ...(harness.contextScopeId === undefined
          ? {}
          : { contextScopeId: harness.contextScopeId }),
        directory: DIRECTORY,
        force: true,
        isSubagent: harness.contextScopeId !== undefined,
        modelId: MODEL_ID,
        toolNames: [],
        tools: undefined,
      });
      await synchronizeCommittedCompaction(harness);
      harness.currentAssistantId = undefined;
      break;
    }
    case "providerOverflow": {
      harness.reference = recordReferenceCompactionAttempt(harness.reference);
      await prepareAndSynchronize(harness, [], true);
      harness.currentAssistantId = undefined;
      break;
    }
    case "abortRun": {
      const history = await listHistory(harness);
      for (const part of history.flatMap((message) => message.parts)) {
        if (part.type !== "tool" || part.state.status === "completed") {
          continue;
        }
        if (part.state.status === "error" || part.state.status === "aborted") {
          continue;
        }
        await harness.messageManager.updatePart(part.id, {
          state: {
            error: ABORTED_RESULT,
            input: part.state.input,
            status: "aborted",
          },
        });
      }
      harness.reference = abortReferenceTools(
        harness.reference,
        ABORTED_RESULT,
      );
      harness.currentAssistantId = undefined;
      break;
    }
    case "restartManager": {
      const before = await materializeModelView(harness);
      harness.rebuildManager();
      harness.reference = restartReferenceManager(harness.reference);
      const after = await materializeModelView(harness);
      expect(after).toEqual(before);
      harness.currentAssistantId = undefined;
      break;
    }
  }

  await assertReferenceInvariants(harness);
}

async function ensureAssistant(
  harness: ReferenceHarness,
  text: string,
): Promise<string> {
  if (harness.currentAssistantId === undefined) {
    const message = await harness.messageManager.createMessage({
      ...(harness.contextScopeId === undefined
        ? {}
        : { contextScopeId: harness.contextScopeId }),
      agent: "reference",
      role: "assistant",
      sessionId: SESSION_ID,
    });
    const part = await harness.messageManager.appendPart(message.id, {
      text,
      type: "text",
    });
    harness.reference = recordReferenceMessage(harness.reference, {
      messageId: message.id,
      partId: part.id,
      role: "assistant",
      text,
    });
    harness.currentAssistantId = message.id;
    return message.id;
  }

  const part = await harness.messageManager.appendPart(
    harness.currentAssistantId,
    { text, type: "text" },
  );
  harness.reference = appendReferenceText(harness.reference, {
    messageId: harness.currentAssistantId,
    partId: part.id,
    text,
  });
  return harness.currentAssistantId;
}

async function findToolPart(
  harness: ReferenceHarness,
  callId: string,
): Promise<ToolPart> {
  const part = (await listHistory(harness))
    .flatMap((message) => message.parts)
    .find(
      (candidate) => candidate.type === "tool" && candidate.callId === callId,
    );
  if (part?.type !== "tool") {
    throw new Error(`Tool part not found: ${callId}`);
  }
  return part;
}

async function prepareAndSynchronize(
  harness: ReferenceHarness,
  toolNames: readonly ToolName[],
  force: boolean,
): Promise<void> {
  const tools = toolsFor(toolNames);
  const prepared = await harness.contextManager.prepareTurn({
    ...(harness.contextScopeId === undefined
      ? {}
      : { contextScopeId: harness.contextScopeId }),
    directory: DIRECTORY,
    force,
    isSubagent: harness.contextScopeId !== undefined,
    modelId: MODEL_ID,
    sessionId: SESSION_ID,
    toolNames,
    tools,
  });
  await synchronizeCommittedCompaction(harness);
  expect(prepared.request.messages).toEqual(
    await materializeModelView(harness),
  );
  expect(prepared.request.tools).toEqual(tools);
  expect(Object.isFrozen(prepared.request)).toBe(true);
  harness.preparedSnapshots.push({
    request: prepared.request,
    value: structuredClone(prepared.request),
  });
}

async function synchronizeCommittedCompaction(
  harness: ReferenceHarness,
): Promise<void> {
  const history = await listHistory(harness);
  const knownMessages = new Set(
    harness.reference.messages.map((message) => message.id),
  );
  const referenceParts = new Map(
    harness.reference.messages.flatMap((message) =>
      message.parts.map((part) => [part.id, part] as const),
    ),
  );
  const newlyCompacted = new Set(
    history.flatMap((message) =>
      message.parts.flatMap((part) => {
        const reference = referenceParts.get(part.id);
        return part.time?.compacted !== undefined &&
          reference !== undefined &&
          !reference.compacted
          ? [part.id]
          : [];
      }),
    ),
  );

  for (const message of history) {
    if (knownMessages.has(message.info.id)) {
      continue;
    }
    const summaryPart = message.parts.find(isContextSummaryPart);
    if (summaryPart?.type !== "text") {
      throw new Error(`Unexpected durable message: ${message.info.id}`);
    }
    harness.reference = applyReferenceCompactionCommit(harness.reference, {
      compactedPartIds: newlyCompacted,
      summaryMessageId: message.info.id,
      summaryPartId: summaryPart.id,
      summaryText: summaryPart.text,
    });
  }
}

async function assertReferenceInvariants(
  harness: ReferenceHarness,
): Promise<void> {
  const actual = await materializeModelView(harness);
  const expected = expectedModelView(harness);
  expect(actual).toEqual(expected);

  for (const snapshot of harness.preparedSnapshots) {
    expect(snapshot.request).toEqual(snapshot.value);
  }

  const activeToolCallIds = actual.flatMap((message) =>
    message.role === "assistant" && "tool_calls" in message
      ? (message.tool_calls?.map((call) => call.id) ?? [])
      : [],
  );
  const resultIds = actual.flatMap((message) =>
    message.role === "tool" ? [message.tool_call_id] : [],
  );
  expect(resultIds).toEqual(activeToolCallIds);

  const history = await listHistory(harness);
  const durablePartIds = history.flatMap((message) =>
    message.parts.map((part) => part.id),
  );
  expect(new Set(durablePartIds).size).toBe(durablePartIds.length);

  for (const referenceMessage of harness.reference.messages) {
    expect(getReferenceMessage(harness.reference, referenceMessage.id)).toEqual(
      referenceMessage,
    );
  }
}

async function materializeModelView(
  harness: ReferenceHarness,
): Promise<readonly ChatCompletionMessage[]> {
  const assembled = await harness.contextManager.assemble(
    SESSION_ID,
    DIRECTORY,
    {
      ...(harness.contextScopeId === undefined
        ? {}
        : { contextScopeId: harness.contextScopeId }),
      isSubagent: harness.contextScopeId !== undefined,
      toolNames: [],
    },
  );
  return serializeForLlm(assembled);
}

function expectedModelView(
  harness: ReferenceHarness,
): readonly ChatCompletionMessage[] {
  const system =
    harness.contextScopeId === undefined
      ? `${SYSTEM_PROMPT}\n\n<memory>\n${MEMORY}\n</memory>`
      : SYSTEM_PROMPT;
  return [
    { content: system, role: "system" as const },
    ...projectReferenceHistory(harness.reference),
  ];
}

function listHistory(harness: ReferenceHarness): Promise<MessageWithParts[]> {
  return harness.contextScopeId === undefined
    ? harness.messageManager.listBySession(SESSION_ID)
    : harness.messageManager.listBySession(SESSION_ID, {
        contextScopeId: harness.contextScopeId,
      });
}

const safeText = fc
  .string({ maxLength: 64, minLength: 1, unit: "grapheme" })
  .map((value) => value.replaceAll("\u0000", " "));
const toolOrder = fc.uniqueArray(
  fc.constantFrom<ToolName>("read", "write", "bash"),
  { maxLength: 3 },
);
const actionArbitrary: fc.Arbitrary<RawAction> = fc.oneof(
  { depthIdentifier: "context-action", maxDepth: 3 },
  fc.record({ text: safeText, type: fc.constant("startUserTurn" as const) }),
  fc.record({
    text: safeText,
    type: fc.constant("appendAssistantDelta" as const),
  }),
  fc.record({
    type: fc.constant("appendToolCall" as const),
    value: fc.integer({ max: 10_000, min: -10_000 }),
  }),
  fc.record({
    result: safeText,
    status: fc.constantFrom<ReferenceToolTerminalStatus>(
      "completed",
      "error",
      "aborted",
    ),
    type: fc.constant("appendToolResult" as const),
  }),
  fc.record({ tools: toolOrder, type: fc.constant("prepareStep" as const) }),
  fc.record({
    inputTokens: fc.integer({ max: 2_000, min: 0 }),
    sentHeuristic: fc.integer({ max: 2_000, min: 0 }),
    type: fc.constant("observeUsage" as const),
  }),
  fc.constant({ type: "autoCompact" as const }),
  fc.constant({ type: "manualCompact" as const }),
  fc.constant({ type: "providerOverflow" as const }),
  fc.constant({ type: "abortRun" as const }),
  fc.constant({ type: "restartManager" as const }),
);

describe("Context reference state machine", () => {
  it("preserves the canonical model view across legal action traces", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.array(actionArbitrary, { maxLength: 36, minLength: 1 }),
        async (isSubagent, actions) => {
          const harness = createHarness(isSubagent);
          try {
            for (const action of actions) {
              await applyAction(harness, action);
            }
          } catch (error) {
            throw new Error(
              `Reference trace failed:\n${serializeReferenceTrace(harness.trace)}`,
              { cause: error },
            );
          }
        },
      ),
      { numRuns: 80, seed: PROPERTY_SEED, verbose: 2 },
    );
  });

  it("keeps forced compaction and restart replay deterministic", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.array(safeText, { maxLength: 8, minLength: 3 }),
        async (isSubagent, turns) => {
          const harness = createHarness(isSubagent);
          for (const [index, text] of turns.entries()) {
            await applyAction(harness, {
              text: `${String(index)}-${text.repeat(4)}`,
              type: "startUserTurn",
            });
            await applyAction(harness, {
              text: `answer-${String(index)}-${text.repeat(4)}`,
              type: "appendAssistantDelta",
            });
          }
          await applyAction(harness, { type: "manualCompact" });
          await applyAction(harness, { type: "restartManager" });
          await applyAction(harness, { tools: ["read"], type: "prepareStep" });
        },
      ),
      { numRuns: 30, seed: PROPERTY_SEED + 1 },
    );
  });

  it("soaks long primary and subagent traces with replayable seeds", async () => {
    for (const [index, isSubagent] of [false, true].entries()) {
      await fc.assert(
        fc.asyncProperty(
          fc.array(actionArbitrary, { maxLength: 120, minLength: 100 }),
          async (actions) => {
            const harness = createHarness(isSubagent);
            try {
              for (const action of actions) {
                await applyAction(harness, action);
              }
            } catch (error) {
              throw new Error(
                `Long reference trace failed:\n${serializeReferenceTrace(harness.trace)}`,
                { cause: error },
              );
            }
          },
        ),
        {
          numRuns: 3,
          seed: PROPERTY_SEED + 10 + index,
          verbose: 2,
        },
      );
    }
  });
});
