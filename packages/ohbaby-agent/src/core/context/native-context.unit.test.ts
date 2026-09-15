import { describe, expect, it } from "vitest";
import type {
  ModelState,
  ModelOrigin,
} from "../../services/interface-providers/native-state.js";
import type { MessageWithParts } from "../message/index.js";
import { serializeHistoryMessages } from "./serializer.js";
import { estimatePreparedRequestHeuristic } from "./token-estimation.js";
import { createMaskConfig, reduceForModel } from "./projection.js";
import { findCutPoint } from "./compaction-policy.js";

const origin: ModelOrigin = {
  provider: "openai",
  model: "fixture",
  protocol: "openai-responses",
  endpoint: "https://fixture.invalid/v1",
};
function state(cipher = "opaque", tokens = 80): ModelState {
  return {
    version: 1,
    origin,
    estimate: { tokens, source: "reasoning" },
    output: {
      protocol: "openai-responses",
      items: [
        {
          type: "reasoning",
          id: "r1",
          summary: [{ type: "summary_text", text: "summary" }],
          encrypted_content: cipher,
        },
        { type: "reasoning", id: "r2", summary: [], encrypted_content: cipher },
      ],
    },
  };
}
function nativeMessage(pending = false): MessageWithParts {
  const modelState = state();
  if (modelState.output.protocol !== "openai-responses")
    throw new Error("fixture protocol");
  modelState.output.items.push({
    type: "function_call",
    id: "fc1",
    call_id: "call1",
    name: "lookup",
    arguments: "{}",
    status: "completed",
  });
  return {
    info: {
      id: "m1",
      role: "assistant",
      agent: "test",
      sessionId: "s",
      finish: "tool_calls",
      time: { created: 1, completed: 2 },
    },
    parts: [
      {
        id: "native",
        type: "model-state",
        modelState,
        messageId: "m1",
        sessionId: "s",
        orderIndex: 0,
      },
      {
        id: "tool",
        type: "tool",
        tool: "lookup",
        callId: "call1",
        state: pending
          ? { status: "pending", input: {}, raw: "{}" }
          : { status: "completed", input: {}, output: "result".repeat(100) },
        messageId: "m1",
        sessionId: "s",
        orderIndex: 1,
      },
    ],
  };
}
function textMessage(
  id: string,
  role: "user" | "assistant",
  text = "hello",
): MessageWithParts {
  return {
    info: { id, role, agent: "test", sessionId: "s", time: { created: 3 } },
    parts: [
      {
        id: `${id}-part`,
        messageId: id,
        sessionId: "s",
        orderIndex: 0,
        type: "text",
        text,
      },
    ],
  };
}
const counter = { estimateTokens: (text: string): number => text.length };

describe("native request occupancy", () => {
  it.each([0, 80])(
    "counts one opaque response proxy of %i plus readable reasoning once",
    (tokens) => {
      const baseline = estimatePreparedRequestHeuristic(
        { messages: [{ role: "assistant", content: null }], tools: undefined },
        counter,
      );
      const count = (cipher: string): number =>
        estimatePreparedRequestHeuristic(
          {
            messages: [
              {
                role: "assistant",
                content: null,
                modelState: state(cipher, tokens),
              },
            ],
            tools: undefined,
          },
          counter,
        );
      expect(count("short")).toBe(baseline + tokens + 7);
      expect(count("x".repeat(50000))).toBe(baseline + tokens + 7);
    },
  );
  it("counts readable thinking once and never estimates signature characters", () => {
    const modelState: ModelState = {
      version: 1,
      origin: { ...origin, protocol: "anthropic" },
      estimate: { tokens: 500, source: "output" },
      output: {
        protocol: "anthropic",
        items: [
          {
            type: "thinking",
            thinking: "visible",
            signature: "signature".repeat(1000),
          },
        ],
      },
    };
    const baseline = estimatePreparedRequestHeuristic(
      { messages: [{ role: "assistant", content: null }], tools: undefined },
      counter,
    );
    expect(
      estimatePreparedRequestHeuristic(
        {
          messages: [{ role: "assistant", content: null, modelState }],
          tools: undefined,
        },
        counter,
      ),
    ).toBe(baseline + 7);
  });
});

describe("native source and compaction boundaries", () => {
  it.each([
    { model: "other" },
    { provider: "other" },
    { endpoint: "https://other.invalid/v1" },
    { protocol: "anthropic" as const },
  ])(
    "drops private state while preserving completed public tool history on source change: %j",
    (change) => {
      const projected = serializeHistoryMessages([nativeMessage()], undefined, {
        ...origin,
        ...change,
      });
      expect(projected).toEqual([
        {
          role: "assistant",
          content: null,
          toolCalls: [{ callId: "call1", name: "lookup", argumentsJson: "{}" }],
        },
        { role: "tool", callId: "call1", content: "result".repeat(100) },
      ]);
      expect(JSON.stringify(projected)).not.toContain("opaque");
    },
  );
  it("rejects a source change with an unfinished native tool roundtrip", () => {
    expect(() =>
      serializeHistoryMessages([nativeMessage(true)], undefined, {
        ...origin,
        model: "other",
      }),
    ).toThrow(/unfinished|pending|source/u);
  });
  it("protects completed native tools from context masking", () => {
    const message = nativeMessage();
    const reduced = reduceForModel({
      sessionId: "s",
      history: [message, textMessage("user", "user")],
      usage: {
        currentTokens: 900,
        contextLimit: 1000,
        remainingTokens: 100,
        usageRatio: 0.9,
        modelId: "fixture",
      },
      cutoff: 0,
      config: createMaskConfig({
        enabled: true,
        minPartTokens: 1,
        minPrunableTokens: 1,
        minUsageRatio: 0,
        protectionTokens: 0,
      }),
      tokenCounter: counter,
    });
    expect(reduced.event.maskedPartIds).toEqual([]);
    expect(reduced.history[0]?.parts).toEqual(message.parts);
  });
  it("never summarizes an unfinished native roundtrip even before later visible messages", () => {
    const history = [
      textMessage("u0", "user", "old".repeat(100)),
      nativeMessage(true),
      textMessage("a2", "assistant", "tail".repeat(100)),
    ];
    const cut = findCutPoint({
      history,
      keepRecentTokens: 1,
      tokenCounter: counter,
    });
    expect(
      cut.messagesToSummarize.some((message) => message.info.id === "m1"),
    ).toBe(false);
    expect(cut.keptMessages.some((message) => message.info.id === "m1")).toBe(
      true,
    );
  });
});

it("uses native occupancy when choosing a summary boundary", () => {
  const native = nativeMessage();
  const history = [
    textMessage("old", "user", "old".repeat(20)),
    native,
    textMessage("new", "user", "new"),
  ];
  const cut = findCutPoint({
    history,
    keepRecentTokens: 900,
    tokenCounter: counter,
  });
  // Public text is under 900 characters, but the actual native request adds the opaque allowance.
  expect(
    cut.messagesToSummarize.length + cut.turnPrefixMessages.length,
  ).toBeGreaterThan(0);
});

it("counts distinct Chat reasoning text and summary without double-counting mirrored text details", () => {
  const baseline = estimatePreparedRequestHeuristic(
    { messages: [{ role: "assistant", content: null }], tools: undefined },
    counter,
  );
  const modelState: ModelState = {
    version: 1,
    origin: { ...origin, protocol: "openai-compatible" },
    estimate: { source: "output", tokens: 100 },
    output: {
      protocol: "openai-compatible",
      reasoningText: "full",
      reasoningDetails: [{ type: "reasoning.summary", summary: "brief" }],
    },
  };
  expect(
    estimatePreparedRequestHeuristic(
      {
        messages: [{ role: "assistant", content: null, modelState }],
        tools: undefined,
      },
      counter,
    ),
  ).toBe(baseline + 10);
  if (modelState.output.protocol !== "openai-compatible")
    throw new Error("fixture protocol");
  modelState.output.reasoningDetails = [
    { type: "reasoning.text", text: "full" },
    { type: "reasoning.summary", summary: "brief" },
  ];
  expect(
    estimatePreparedRequestHeuristic(
      {
        messages: [{ role: "assistant", content: null, modelState }],
        tools: undefined,
      },
      counter,
    ),
  ).toBe(baseline + 10);
});

it("does not count a visible reasoning convenience field twice when native state already replays it", () => {
  const modelState: ModelState = {
    version: 1,
    origin: { ...origin, protocol: "openai-compatible" },
    estimate: { source: "text", tokens: 7 },
    output: { protocol: "openai-compatible", reasoningText: "visible" },
  };
  const baseline = estimatePreparedRequestHeuristic(
    { messages: [{ role: "assistant", content: null }], tools: undefined },
    counter,
  );
  expect(
    estimatePreparedRequestHeuristic(
      {
        messages: [
          {
            role: "assistant",
            content: null,
            modelState,
            reasoningText: "visible",
          },
        ],
        tools: undefined,
      },
      counter,
    ),
  ).toBe(baseline + 7);
});
