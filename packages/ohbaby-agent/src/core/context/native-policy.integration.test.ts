import { describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import type {
  ModelOrigin,
  ModelState,
} from "../../services/interface-providers/native-state.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  type MessageWithParts,
  type MessageStore,
} from "../message/index.js";
import type { ContextManager } from "./types.js";
import { createContextManager } from "./context-manager.js";
import { serializeHistory } from "./serialization.js";

const origin: ModelOrigin = {
  provider: "openai",
  model: "native-fixture",
  protocol: "openai-responses",
  endpoint: "https://fixture.invalid/v1",
};
const modelState: ModelState = {
  version: 1,
  origin,
  output: {
    protocol: "openai-responses",
    items: [
      {
        type: "reasoning",
        id: "r",
        summary: [],
        encrypted_content: "opaque-must-not-leak",
      },
      {
        type: "function_call",
        id: "fc",
        call_id: "call-native",
        name: "lookup",
        arguments: "{}",
        status: "completed",
      },
    ],
  },
  estimate: { tokens: 200, source: "output" },
};
function history(): MessageWithParts[] {
  return [
    {
      info: {
        id: "old-user",
        role: "user",
        agent: "test",
        sessionId: "s",
        time: { created: 1 },
      },
      parts: [
        {
          id: "old-text",
          messageId: "old-user",
          sessionId: "s",
          orderIndex: 0,
          type: "text",
          text: "history constraint ".repeat(100),
        },
      ],
    },
    {
      info: {
        id: "native",
        role: "assistant",
        agent: "test",
        sessionId: "s",
        finish: "tool_calls",
        time: { created: 2, completed: 3 },
      },
      parts: [
        {
          id: "native-state",
          messageId: "native",
          sessionId: "s",
          orderIndex: 0,
          type: "model-state",
          modelState,
        },
        {
          id: "native-tool",
          messageId: "native",
          sessionId: "s",
          orderIndex: 1,
          type: "tool",
          tool: "lookup",
          callId: "call-native",
          state: {
            status: "completed",
            input: {},
            output: "native result ".repeat(50),
          },
        },
      ],
    },
    {
      info: {
        id: "ordinary",
        role: "assistant",
        agent: "test",
        sessionId: "s",
        finish: "tool_calls",
        time: { created: 4, completed: 5 },
      },
      parts: [
        {
          id: "ordinary-tool",
          messageId: "ordinary",
          sessionId: "s",
          orderIndex: 0,
          type: "tool",
          tool: "lookup",
          callId: "call-old",
          state: {
            status: "completed",
            input: {},
            output: "ordinary result ".repeat(50),
          },
        },
      ],
    },
    {
      info: {
        id: "new-user",
        role: "user",
        agent: "test",
        sessionId: "s",
        time: { created: 6 },
      },
      parts: [
        {
          id: "new-text",
          messageId: "new-user",
          sessionId: "s",
          orderIndex: 0,
          type: "text",
          text: "new question",
        },
      ],
    },
  ];
}
async function harness(
  preserveRatio: number,
  summaryText = "Retain the history constraint and lookup result.",
): Promise<{
  manager: ContextManager;
  store: MessageStore;
  summaryInputs: string[];
  summaryReasoning: unknown[];
}> {
  const bus = createBus();
  const store = createInMemoryMessageStore();
  for (const message of history()) {
    await store.insertMessage(message.info);
    for (const part of message.parts) {
      const data =
        part.type === "model-state"
          ? { type: part.type, modelState: part.modelState }
          : part.type === "tool"
            ? {
                type: part.type,
                tool: part.tool,
                callId: part.callId,
                state: part.state,
              }
            : part.type === "text"
              ? { type: part.type, text: part.text }
              : { type: part.type, text: part.text };
      await store.appendPart({
        message: message.info,
        partId: part.id,
        data,
        updatedAt: message.info.time.created,
      });
    }
  }
  const summaryInputs: string[] = [];
  const summaryReasoning: unknown[] = [];
  const manager = createContextManager({
    bus,
    messageManager: createMessageManager({ bus, store }),
    memory: {
      load: () => Promise.resolve({ global: "", project: "", merged: "" }),
    },
    systemPromptProvider: { build: () => Promise.resolve("") },
    tokenCounter: {
      estimateTokens: (text) => text.length,
      getLimit: () => 1_000_000,
    },
    llmClient: {
      generateSummary: (input) => {
        summaryInputs.push(serializeHistory(input.history));
        summaryReasoning.push(input.reasoning);
        return Promise.resolve(summaryText);
      },
    },
    pruneProtectTokens: 0,
    pruneMinimumTokens: 1,
    compressionPreserveRatio: preserveRatio,
  });
  return { manager, store, summaryInputs, summaryReasoning };
}

describe("native context policy with production manager and store", () => {
  it("prunes ordinary old tools while keeping every native dependency active", async () => {
    const { manager, store } = await harness(1);
    const result = await manager.compact("s", {
      directory: "/fixture",
      modelId: origin.model,
      modelOrigin: origin,
      tools: undefined,
      toolNames: [],
      force: true,
    });
    expect(result.prune?.prunedCount).toBe(1);
    const parts = (await store.listBySession("s")).flatMap(
      (message) => message.parts,
    );
    expect(
      parts.find((part) => part.id === "ordinary-tool")?.time?.compacted,
    ).toBeDefined();
    expect(
      parts.find((part) => part.id === "native-tool")?.time?.compacted,
    ).toBeUndefined();
    expect(
      parts.find((part) => part.id === "native-state")?.time?.compacted,
    ).toBeUndefined();
  });
  it("compacts a completed native unit atomically and excludes old state from the prepared request", async () => {
    const { manager, store, summaryInputs } = await harness(0.1);
    const result = await manager.compact("s", {
      directory: "/fixture",
      modelId: origin.model,
      modelOrigin: origin,
      tools: undefined,
      toolNames: [],
      force: true,
    });
    expect(result.compression?.status).toBe("compressed");
    expect(summaryInputs.length).toBeGreaterThan(0);
    expect(summaryInputs.join("")).not.toContain("opaque-must-not-leak");
    const parts = (await store.listBySession("s")).flatMap(
      (message) => message.parts,
    );
    const stateTime = parts.find((part) => part.id === "native-state")?.time
      ?.compacted;
    expect(stateTime).toBeDefined();
    expect(
      parts.find((part) => part.id === "native-tool")?.time?.compacted,
    ).toBe(stateTime);
    const turn = await manager.prepareTurn({
      sessionId: "s",
      directory: "/fixture",
      modelId: origin.model,
      modelOrigin: origin,
      tools: undefined,
      toolNames: [],
    });
    expect(
      turn.request.messages.some(
        (message) =>
          message.role === "assistant" && message.modelState !== undefined,
      ),
    ).toBe(false);
    expect(JSON.stringify(turn.request)).toContain("context_summary");
  });
  it("filters source before both actual prepared request and occupancy measurement", async () => {
    const { manager } = await harness(1);
    const base = {
      sessionId: "s",
      directory: "/fixture",
      modelId: origin.model,
      tools: undefined,
      toolNames: [],
    };
    const same = await manager.prepareTurn({ ...base, modelOrigin: origin });
    const different = await manager.prepareTurn({
      ...base,
      modelOrigin: { ...origin, endpoint: "https://other.invalid/v1" },
    });
    expect(same.sentHeuristic - different.sentHeuristic).toBe(200);
    expect(JSON.stringify(different.request)).not.toContain(
      "opaque-must-not-leak",
    );
    expect(
      same.composition?.conversation === undefined ||
        different.composition?.conversation === undefined,
    ).toBe(false);
    expect(
      (same.composition?.conversation ?? 0) -
        (different.composition?.conversation ?? 0),
    ).toBe(200);
  });
});

it("passes the owning reasoning snapshot to context summary without changing its strength", async () => {
  const { manager, summaryReasoning } = await harness(0.1);
  const reasoning = {
    enabled: true,
    effort: "high",
    explicit: { enabled: true, effort: true },
  };
  const pending = manager.compact("s", {
    directory: "/fixture",
    modelId: origin.model,
    modelOrigin: origin,
    tools: undefined,
    toolNames: [],
    force: true,
    reasoning,
  });
  reasoning.effort = "low";
  await pending;
  expect(summaryReasoning).toEqual([
    {
      enabled: true,
      effort: "high",
      explicit: { enabled: true, effort: true },
    },
  ]);
});

it("does not retire native history when the summary response is blank", async () => {
  const { manager, store } = await harness(0.1, "   ");
  const result = await manager.compact("s", {
    directory: "/fixture",
    modelId: origin.model,
    modelOrigin: origin,
    tools: undefined,
    toolNames: [],
    force: true,
  });
  expect(result.compression?.status).toBe("failed");
  const native = (await store.listBySession("s")).find(
    (message) => message.info.id === "native",
  );
  expect(
    native?.parts.every((part) => part.time?.compacted === undefined),
  ).toBe(true);
});
