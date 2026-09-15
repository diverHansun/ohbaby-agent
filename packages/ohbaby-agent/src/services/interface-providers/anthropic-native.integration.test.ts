import { afterEach, describe, expect, it, vi } from "vitest";
import { streamResponse as streamModelResponse } from "../../core/llm-client/streaming.js";
import type { StreamingResponse } from "../../core/llm-client/types.js";
import { resolveRequestReasoning } from "./reasoning.js";
import { createAnthropicProvider } from "./anthropic.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  ModelMessage,
} from "./types.js";

type WireEvent = Record<string, unknown>;
const request: InterfaceProviderRequest = {
  model: "claude-fixture",
  messages: [{ role: "user", content: "fixture" }],
  temperature: 0,
  maxTokens: 4096,
  promptCache: { strategy: "observe-only", reason: "fixture" },
};
const start = (): WireEvent => ({
  type: "message_start",
  message: {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: request.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 0 },
  },
});
const terminal = (reason = "tool_use"): WireEvent[] => [
  {
    type: "message_delta",
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: 5 },
  },
  { type: "message_stop" },
];
function block(
  index: number,
  content: Record<string, unknown>,
  deltas: Record<string, unknown>[] = [],
): WireEvent[] {
  return [
    { type: "content_block_start", index, content_block: content },
    ...deltas.map((delta) => ({ type: "content_block_delta", index, delta })),
    { type: "content_block_stop", index },
  ];
}
function fixture(events: WireEvent[]): {
  provider: ReturnType<typeof createAnthropicProvider>;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init: RequestInit) => {
      if (typeof init.body !== "string")
        throw new Error("Expected SDK JSON request body");
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      const sse = events
        .map(
          (event) =>
            `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join("");
      return Promise.resolve(
        new Response(sse, {
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }),
  );
  const provider = createAnthropicProvider({
    id: "fixture",
    apiKey: "local-fixture",
    baseUrl: "http://fixture.invalid",
  });
  return { provider, bodies };
}
async function collect(
  provider: ReturnType<typeof createAnthropicProvider>,
  input = request,
): Promise<InterfaceProviderStreamEvent[]> {
  const frames: InterfaceProviderStreamEvent[] = [];
  for await (const frame of await provider.streamResponse(input))
    frames.push(frame);
  return frames;
}
function nativeOutput(frames: InterfaceProviderStreamEvent[]): unknown {
  return frames
    .map((frame) => Reflect.get(frame, "nativeOutput"))
    .find((value) => value !== undefined);
}
function toolArguments(frames: InterfaceProviderStreamEvent[]): string {
  return frames
    .flatMap((frame) => frame.toolCallDeltas ?? [])
    .map((delta) => delta.argumentsDelta ?? "")
    .join("");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Anthropic native continuation through SDK SSE", () => {
  it.each([0, 4])(
    "retains thinking token subset %s without adding it to billed output",
    async (thinking_tokens) => {
      const ending = terminal("end_turn");
      ending[0].usage = {
        output_tokens: 5,
        output_tokens_details: { thinking_tokens },
      };
      const { provider } = fixture([
        start(),
        ...block(0, {
          type: "thinking",
          thinking: "private",
          signature: "signed",
        }),
        ...ending,
      ]);
      const frames = await collect(provider);
      expect(
        frames.find((frame) => frame.reasoningTokens !== undefined)
          ?.reasoningTokens,
      ).toBe(thinking_tokens);
      expect(frames.find((frame) => frame.finishReason)?.tokenUsage).toEqual({
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
      });
    },
  );

  it("places explicit cache markers on eligible text before native thinking-only history", async () => {
    const { provider, bodies } = fixture([start(), ...terminal("end_turn")]);
    await collect(provider, {
      ...request,
      promptCache: {
        strategy: "anthropic-explicit-last-block",
        reason: "fixture",
      },
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: "",
          modelState: {
            version: 1,
            origin: {
              provider: "fixture",
              model: request.model,
              protocol: "anthropic",
              endpoint: "http://fixture.invalid",
            },
            output: {
              protocol: "anthropic",
              items: [
                {
                  type: "thinking",
                  thinking: "private",
                  signature: "opaque-signature",
                },
              ],
            },
            estimate: { tokens: 5, source: "output" },
          },
        },
      ],
    });
    expect(bodies[0]?.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "fixture",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "private",
            signature: "opaque-signature",
          },
        ],
      },
    ]);
  });

  it.each([
    {
      enabled: true,
      wire: "anthropic-adaptive" as const,
      effort: "medium",
      expected: {
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
      },
    },
    {
      enabled: true,
      wire: "anthropic-budget" as const,
      effort: "high",
      expected: { thinking: { type: "enabled", budget_tokens: 2048 } },
    },
    {
      enabled: false,
      wire: "anthropic-adaptive" as const,
      effort: "high",
      expected: { thinking: { type: "disabled" } },
    },
  ])(
    "sends resolved $wire enabled=$enabled and preserves cache policy",
    async ({ enabled, wire, effort, expected }) => {
      const { provider, bodies } = fixture([start(), ...terminal("end_turn")]);
      const reasoning = resolveRequestReasoning({
        provider: "fixture",
        baseUrl: "http://fixture.invalid",
        interfaceProvider: "anthropic",
        model: request.model,
        maxTokens: request.maxTokens,
        reasoning: { enabled, effort },
        modelProfiles: [
          {
            model: request.model,
            provider: "fixture",
            contextWindowTokens: 100000,
            reasoningCapabilities: {
              mode: "effort",
              wire,
              supportsDisabled: true,
              efforts: ["medium", "high"],
              budgets: { high: 2048 },
              temperature: "disabled-only",
            },
          },
        ],
      });
      await collect(provider, {
        ...request,
        temperature: undefined,
        reasoning,
        promptCache: {
          strategy: "anthropic-top-level-auto",
          reason: "fixture",
        },
        messages: [
          { role: "system", content: "Stable instructions" },
          ...request.messages,
        ],
      });
      expect(bodies[0]).toMatchObject({
        ...expected,
        cache_control: { type: "ephemeral" },
        system: [
          {
            type: "text",
            text: "Stable instructions",
            cache_control: { type: "ephemeral" },
          },
        ],
      });
      expect(bodies[0]).not.toHaveProperty("temperature");
      if (!enabled) expect(bodies[0]).not.toHaveProperty("output_config");
    },
  );

  it.each([
    {
      name: "empty initial object without deltas",
      input: {},
      deltas: [],
      expected: {},
    },
    {
      name: "empty initial object with empty delta",
      input: {},
      deltas: [""],
      expected: {},
    },
    {
      name: "complete initial object without deltas",
      input: { city: "Taipei" },
      deltas: [],
      expected: { city: "Taipei" },
    },
    {
      name: "fragmented JSON replaces initial empty object",
      input: {},
      deltas: ['{"city":', '"Taipei"}'],
      expected: { city: "Taipei" },
    },
  ])("retains $name", async ({ input, deltas, expected }) => {
    const { provider } = fixture([
      start(),
      ...block(
        0,
        { type: "tool_use", id: "call_fixture", name: "lookup", input },
        deltas.map((partial_json) => ({
          type: "input_json_delta",
          partial_json,
        })),
      ),
      ...terminal(),
    ]);
    const frames = await collect(provider);
    expect(JSON.parse(toolArguments(frames))).toEqual(expected);
    expect(nativeOutput(frames)).toEqual({
      protocol: "anthropic",
      items: [
        {
          type: "tool_use",
          id: "call_fixture",
          name: "lookup",
          input: expected,
        },
      ],
    });
    expect(frames.find((frame) => frame.finishReason)).toMatchObject({
      finishReason: "tool_calls",
      rawFinishReason: "tool_use",
      tokenUsage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    });
  });

  it.each([
    { input: {}, deltas: [] },
    { input: {}, deltas: [""] },
    { input: { city: "Taipei" }, deltas: [] },
  ])(
    "parses initial tool input only after final SDK exhaustion: %j",
    async ({ input, deltas }) => {
      const { provider } = fixture([
        start(),
        ...block(
          0,
          { type: "tool_use", id: "call_fixture", name: "lookup", input },
          deltas.map((partial_json) => ({
            type: "input_json_delta",
            partial_json,
          })),
        ),
        ...terminal(),
      ]);
      let final: StreamingResponse | undefined;
      for await (const frame of streamModelResponse(
        {
          provider,
          config: {
            provider: "fixture",
            model: request.model,
            baseUrl: "http://fixture.invalid",
            interfaceProvider: "anthropic",
            maxTokens: request.maxTokens,
            modelProfiles: [
              {
                model: request.model,
                contextWindowTokens: 100000,
                reasoningCapabilities: {
                  mode: "effort",
                  wire: "anthropic-adaptive",
                  supportsDisabled: true,
                  efforts: ["medium"],
                  temperature: "disabled-only",
                },
              },
            ],
          },
        },
        request.messages,
        { retry: { maxRetriesPerStep: 0 } },
      ))
        final = frame;
      expect(final?.parsedToolCalls).toEqual([
        { callId: "call_fixture", name: "lookup", arguments: input },
      ]);
      expect(final?.tokenUsage).toMatchObject({
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
      });
    },
  );

  it("keeps interleaved tool argument streams separate and ordered", async () => {
    const { provider } = fixture([
      start(),
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call_a",
          name: "lookup",
          input: {},
        },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call_b",
          name: "lookup",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"city":' },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"Taipei"}' },
      },
      { type: "content_block_stop", index: 0 },
      ...terminal(),
    ]);
    const frames = await collect(provider);
    const deltas = frames.flatMap((frame) => frame.toolCallDeltas ?? []);
    expect(
      JSON.parse(
        deltas
          .filter((delta) => delta.index === 0)
          .map((delta) => delta.argumentsDelta ?? "")
          .join(""),
      ),
    ).toEqual({ city: "Taipei" });
    expect(
      JSON.parse(
        deltas
          .filter((delta) => delta.index === 1)
          .map((delta) => delta.argumentsDelta ?? "")
          .join(""),
      ),
    ).toEqual({ city: "Paris" });
    expect(nativeOutput(frames)).toEqual({
      protocol: "anthropic",
      items: [
        {
          type: "tool_use",
          id: "call_a",
          name: "lookup",
          input: { city: "Taipei" },
        },
        {
          type: "tool_use",
          id: "call_b",
          name: "lookup",
          input: { city: "Paris" },
        },
      ],
    });
  });

  it.each(['{"city":', '{"city":oops}', "[]", "null"])(
    "rejects incomplete or non-object tool JSON: %s",
    async (partial_json) => {
      const { provider } = fixture([
        start(),
        ...block(
          0,
          { type: "tool_use", id: "call_fixture", name: "lookup", input: {} },
          [{ type: "input_json_delta", partial_json }],
        ),
        ...terminal(),
      ]);
      await expect(collect(provider)).rejects.toThrow();
    },
  );

  it("preserves ordered thinking, signature, redacted data, text and tools in next request", async () => {
    const items = [
      {
        type: "thinking",
        thinking: "Private reasoning",
        signature: "opaque-signature",
      },
      { type: "text", text: "Checking." },
      { type: "redacted_thinking", data: "opaque-redacted" },
      {
        type: "tool_use",
        id: "call_fixture",
        name: "lookup",
        input: { city: "Taipei" },
      },
    ];
    const { provider, bodies } = fixture([
      start(),
      ...block(0, { type: "thinking", thinking: "", signature: "" }, [
        { type: "thinking_delta", thinking: "Private reasoning" },
        { type: "signature_delta", signature: "opaque-signature" },
      ]),
      ...block(1, { type: "text", text: "" }, [
        { type: "text_delta", text: "Checking." },
      ]),
      ...block(2, items[2]),
      ...block(3, items[3]),
      ...terminal(),
    ]);
    const frames = await collect(provider);
    expect(nativeOutput(frames)).toEqual({ protocol: "anthropic", items });
    expect(frames.map((frame) => frame.textDelta ?? "").join("")).toBe(
      "Checking.",
    );
    expect(
      JSON.stringify(
        frames.filter((frame) => !Reflect.has(frame, "nativeOutput")),
      ),
    ).not.toContain("opaque-");
    const assistant = {
      role: "assistant",
      content: "Checking.",
      toolCalls: [
        {
          callId: "call_fixture",
          name: "lookup",
          argumentsJson: '{"city":"Taipei"}',
        },
      ],
      modelState: {
        version: 1,
        origin: {
          provider: "fixture",
          model: request.model,
          protocol: "anthropic",
          endpoint: "http://fixture.invalid",
        },
        output: nativeOutput(frames),
        estimate: { tokens: 32, source: "output" },
      },
    } as unknown as ModelMessage;
    await collect(provider, {
      ...request,
      messages: [
        ...request.messages,
        assistant,
        { role: "tool", callId: "call_fixture", content: "Sunny" },
      ],
    });
    expect(bodies[1]?.messages).toEqual([
      { role: "user", content: "fixture" },
      { role: "assistant", content: items },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_fixture",
            content: "Sunny",
          },
        ],
      },
    ]);
  });

  it("rejects conflicting complete initial tool input and nonempty deltas", async () => {
    const { provider } = fixture([
      start(),
      ...block(
        0,
        {
          type: "tool_use",
          id: "call_fixture",
          name: "lookup",
          input: { city: "Paris" },
        },
        [{ type: "input_json_delta", partial_json: '{"city":"Taipei"}' }],
      ),
      ...terminal(),
    ]);
    await expect(collect(provider)).rejects.toThrow();
  });

  it("accepts a signature completed after block stop and before message stop", async () => {
    const { provider } = fixture([
      start(),
      ...block(0, { type: "thinking", thinking: "private", signature: "" }),
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "late-signature" },
      },
      ...terminal("end_turn"),
    ]);
    const frames = await collect(provider);
    expect(nativeOutput(frames)).toEqual({
      protocol: "anthropic",
      items: [
        { type: "thinking", thinking: "private", signature: "late-signature" },
      ],
    });
  });

  it("rejects a final thinking block without signature", async () => {
    const { provider } = fixture([
      start(),
      ...block(0, { type: "thinking", thinking: "private", signature: "" }),
      ...terminal("end_turn"),
    ]);
    await expect(collect(provider)).rejects.toThrow();
  });

  it("does not accept native state from a stream without message_stop", async () => {
    const { provider } = fixture([
      start(),
      ...block(0, {
        type: "thinking",
        thinking: "private",
        signature: "signed",
      }),
      terminal()[0],
    ]);
    await expect(collect(provider)).rejects.toThrow();
  });
});

it("rejects a new Anthropic tool block after the finish reason", async () => {
  const { provider } = fixture([
    start(),
    ...block(0, { type: "text", text: "done" }),
    terminal("end_turn")[0],
    ...block(1, { type: "tool_use", id: "late", name: "late_tool", input: {} }),
    { type: "message_stop" },
  ]);
  await expect(collect(provider)).rejects.toThrow(/after.*finish/i);
});
