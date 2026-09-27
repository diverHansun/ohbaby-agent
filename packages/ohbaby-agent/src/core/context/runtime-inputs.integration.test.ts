import { describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  type MessageWithParts,
} from "../message/index.js";
import { createContextManager } from "./context-manager.js";
import { estimatePreparedRequestHeuristic } from "./token-estimation.js";

async function setup(limit = 10000) {
  const messages = createMessageManager({
    bus: createBus(),
    store: createInMemoryMessageStore(),
  });
  for (let index = 0; index < 8; index++) {
    const message = await messages.createMessage({
      id: `old-${String(index)}`,
      sessionId: "session",
      role: index % 2 ? "assistant" : "user",
      agent: "primary",
    });
    await messages.appendPart(message.id, {
      type: "text",
      text: `Old context ${String(index)} ` + "x".repeat(300),
    });
  }
  const input = await messages.createMessage({
    id: "input-message",
    runId: "run-a",
    sessionId: "session",
    role: "user",
    agent: "primary",
    runtimeInput: {
      kind: "user-steer",
      inputId: "input-a",
      targetRunId: "run-a",
      sourceId: "prompt",
    },
  });
  await messages.appendPart(input.id, {
    type: "text",
    text: "UNSENT-STEER-ORIGINAL",
  });
  const protectedInput = (await messages.listBySession("session")).find(
    (message) => message.info.id === input.id,
  );
  if (!protectedInput) throw new Error("Input missing");
  const summaries: readonly MessageWithParts[][] = [];
  const collected: MessageWithParts[][] = [];
  const counter = {
    estimateTokens: (text: string): number => text.length,
    getLimit: (): number => limit,
  };
  const context = createContextManager({
    bus: createBus(),
    messageManager: messages,
    memory: {
      load: () => Promise.resolve({ global: "", project: "", merged: "" }),
    },
    systemPromptProvider: { build: () => Promise.resolve("system") },
    tokenCounter: counter,
    llmClient: {
      generateSummary: (input) => {
        collected.push([...input.history]);
        return Promise.resolve("condensed history");
      },
    },
    maskEnabled: false,
    compressionPreserveRatio: 0.1,
  });
  void summaries;
  return { context, messages, protectedInput, collected, counter };
}
const prepare = {
  sessionId: "session",
  runId: "run-a",
  directory: "/repo",
  modelId: "model",
  toolNames: [],
  tools: undefined,
};
describe("durable inputs in prepared context", () => {
  it("preserves actual input body through compaction and measures exactly what it sends", async () => {
    const { context, protectedInput, collected, counter } = await setup();
    const prepared = await context.prepareTurn({
      ...prepare,
      force: true,
      protectedInputs: [protectedInput],
    });
    expect(prepared.request.inputIds).toEqual(["input-a"]);
    expect(
      JSON.stringify(prepared.request.messages).match(/UNSENT-STEER-ORIGINAL/g),
    ).toHaveLength(1);
    expect(collected.length).toBeGreaterThan(0);
    expect(JSON.stringify(collected)).not.toContain("UNSENT-STEER-ORIGINAL");
    expect(prepared.sentHeuristic).toBe(
      estimatePreparedRequestHeuristic(prepared.request, counter),
    );
    expect(prepared.composition).toBeDefined();
  });
  it("never replays an unsent old-run input into another run or its summary", async () => {
    const { context, collected } = await setup();
    const prepared = await context.prepareTurn({
      ...prepare,
      runId: "run-b",
      force: true,
    });
    expect(JSON.stringify(prepared.request.messages)).not.toContain(
      "UNSENT-STEER-ORIGINAL",
    );
    expect(JSON.stringify(collected)).not.toContain("UNSENT-STEER-ORIGINAL");
  });
  it("rejects wrong ownership and finite budget overflow without summarizing protected input", async () => {
    const { context, protectedInput, collected } = await setup(100);
    await expect(
      context.prepareTurn({
        ...prepare,
        runId: "run-b",
        protectedInputs: [protectedInput],
      }),
    ).rejects.toThrow("owner");
    const oversized = {
      ...protectedInput,
      parts: protectedInput.parts.map((part) =>
        part.type === "text"
          ? { ...part, text: "protected".repeat(1000) }
          : part,
      ),
    };
    await expect(
      context.prepareTurn({ ...prepare, protectedInputs: [oversized] }),
    ).rejects.toThrow("budget");
    expect(JSON.stringify(collected)).not.toContain("protectedprotected");
  });
});
