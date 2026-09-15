import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import { resolveRequestReasoning } from "./reasoning.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  ModelMessage,
} from "./types.js";

type Chunk = Record<string, unknown>;
const origin = {
  provider: "fixture",
  model: "chat-fixture",
  protocol: "openai-compatible" as const,
  endpoint: "http://fixture.invalid/v1",
};
const request: InterfaceProviderRequest = {
  model: origin.model,
  messages: [{ role: "user", content: "fixture" }],
  maxTokens: 4096,
  promptCache: { strategy: "observe-only", reason: "fixture" },
};
function chunk(
  delta: Record<string, unknown>,
  finish_reason: string | null = null,
): Chunk {
  return {
    id: "chat_fixture",
    created: 0,
    model: origin.model,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason }],
  };
}
function fixture(chunks: Chunk[]): {
  provider: ReturnType<typeof createOpenAICompatibleProvider>;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init: RequestInit) => {
      if (typeof init.body !== "string")
        throw new Error("Expected SDK JSON request body");
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return Promise.resolve(
        new Response(
          chunks.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    }),
  );
  return {
    provider: createOpenAICompatibleProvider({
      id: origin.provider,
      apiKey: "local-fixture",
      baseUrl: origin.endpoint,
    }),
    bodies,
  };
}
async function collect(
  provider: ReturnType<typeof createOpenAICompatibleProvider>,
  input = request,
): Promise<InterfaceProviderStreamEvent[]> {
  const frames: InterfaceProviderStreamEvent[] = [];
  for await (const frame of await provider.streamResponse(input))
    frames.push(frame);
  return frames;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Chat native reasoning through SDK SSE", () => {
  it.each([
    {
      wire: "openai" as const,
      enabled: true,
      expected: { reasoning_effort: "medium" },
    },
    {
      wire: "openai" as const,
      enabled: false,
      expected: { reasoning_effort: "none" },
    },
    {
      wire: "thinking" as const,
      enabled: true,
      expected: { thinking: { type: "enabled" } },
    },
    {
      wire: "enable-thinking" as const,
      enabled: false,
      expected: { enable_thinking: false },
    },
    {
      wire: "reasoning" as const,
      enabled: true,
      expected: { reasoning: { enabled: true, effort: "medium" } },
    },
  ])(
    "sends only the selected $wire enabled=$enabled wire parameters",
    async ({ wire, enabled, expected }) => {
      const { provider, bodies } = fixture([
        chunk({ content: "done" }, "stop"),
      ]);
      const reasoning = resolveRequestReasoning({
        provider: origin.provider,
        baseUrl: origin.endpoint,
        model: origin.model,
        interfaceProvider: origin.protocol,
        maxTokens: request.maxTokens,
        reasoning: { enabled },
        modelProfiles: [
          {
            model: origin.model,
            contextWindowTokens: 100000,
            reasoningCapabilities: {
              mode:
                wire === "thinking" || wire === "enable-thinking"
                  ? "binary"
                  : "effort",
              wire,
              ...(wire === "thinking" || wire === "enable-thinking"
                ? {}
                : { efforts: ["medium"] }),
              supportsDisabled: true,
            },
          },
        ],
      });
      await collect(provider, {
        ...request,
        reasoning,
        promptCache: {
          strategy: "openai-keyed-implicit",
          key: "stable-key",
          reason: "fixture",
        },
      });
      expect(bodies[0]).toEqual({
        model: origin.model,
        messages: request.messages,
        max_tokens: 4096,
        stream: true,
        stream_options: { include_usage: true },
        prompt_cache_key: "stable-key",
        ...expected,
      });
    },
  );

  it.each(["reasoning_content", "reasoning"])(
    "retains %s and signed/encrypted detail order for the next request",
    async (field) => {
      const details = [
        {
          type: "reasoning.text",
          id: "reason_a",
          index: 0,
          format: "anthropic-claude-v1",
          text: "Think carefully",
          signature: "opaque-signature",
        },
        {
          type: "reasoning.encrypted",
          id: "reason_b",
          index: 1,
          format: "openai-responses-v1",
          data: "opaque-encrypted",
        },
      ];
      const { provider, bodies } = fixture([
        chunk({
          [field]: "Think ",
          reasoning_details: [
            { ...details[0], text: "Think ", signature: null },
          ],
        }),
        chunk({
          [field]: "carefully",
          reasoning_details: [
            { index: 0, text: "carefully", signature: "opaque-signature" },
            details[1],
          ],
        }),
        chunk(
          {
            content: "Answer",
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
          "tool_calls",
        ),
      ]);
      const frames = await collect(provider);
      const output = frames.find((frame) => frame.nativeOutput)?.nativeOutput;
      expect(output).toEqual({
        protocol: origin.protocol,
        reasoningText: "Think carefully",
        reasoningField: field,
        reasoningDetails: details,
      });
      expect(frames.map((frame) => frame.textDelta ?? "").join("")).toBe(
        "Answer",
      );
      expect(
        JSON.stringify(frames.filter((frame) => !frame.nativeOutput)),
      ).not.toContain("opaque-");
      const assistant = {
        role: "assistant",
        content: "Answer",
        toolCalls: [{ callId: "call_a", name: "lookup", argumentsJson: "{}" }],
        modelState: {
          version: 1,
          origin,
          output,
          estimate: { tokens: 20, source: "output" },
        },
      } as ModelMessage;
      await collect(provider, {
        ...request,
        messages: [
          ...request.messages,
          assistant,
          { role: "tool", callId: "call_a", content: "done" },
        ],
      });
      expect(bodies[1]?.messages).toEqual([
        ...request.messages,
        {
          role: "assistant",
          content: "Answer",
          tool_calls: [
            {
              id: "call_a",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
          [field]: "Think carefully",
          reasoning_details: details,
        },
        { role: "tool", tool_call_id: "call_a", content: "done" },
      ]);
    },
  );

  it("does not send incompatible private history to a different endpoint", async () => {
    const { provider, bodies } = fixture([chunk({ content: "done" }, "stop")]);
    await collect(provider, {
      ...request,
      messages: [
        {
          role: "assistant",
          content: "Visible",
          reasoningText: "private legacy projection",
          modelState: {
            version: 1,
            origin: { ...origin, endpoint: "http://other.invalid" },
            output: {
              protocol: origin.protocol,
              reasoningText: "private",
              reasoningDetails: [
                { type: "reasoning.encrypted", data: "opaque" },
              ],
            },
            estimate: { tokens: 10, source: "output" },
          },
        },
      ],
    });
    expect(bodies[0]?.messages).toEqual([
      { role: "assistant", content: "Visible" },
    ]);
  });

  it("rejects unsupported opaque detail types", async () => {
    const { provider } = fixture([
      chunk({
        reasoning_details: [{ type: "arbitrary.secret", data: "opaque" }],
      }),
      chunk({}, "stop"),
    ]);
    await expect(collect(provider)).rejects.toThrow();
  });

  it("rejects opaque fields outside the supported detail type instead of dropping them", async () => {
    const { provider } = fixture([
      chunk(
        {
          reasoning_details: [
            {
              type: "reasoning.encrypted",
              data: "opaque",
              signature: "unsupported-signature",
            },
          ],
        },
        "stop",
      ),
    ]);
    await expect(collect(provider)).rejects.toThrow();
  });

  it("does not emit a replayable collection when the SDK reports a trailing error", async () => {
    const { provider } = fixture([
      chunk(
        {
          reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }],
        },
        "stop",
      ),
      { error: { message: "fixture stream failure" } },
    ]);
    const frames: InterfaceProviderStreamEvent[] = [];
    await expect(
      (async (): Promise<void> => {
        for await (const frame of await provider.streamResponse(request))
          frames.push(frame);
      })(),
    ).rejects.toThrow();
    expect(frames.some((frame) => frame.nativeOutput !== undefined)).toBe(
      false,
    );
  });

  it("keeps length usage without accepting partial native state", async () => {
    const final = chunk(
      { reasoning_details: [{ type: "reasoning.encrypted", data: "partial" }] },
      "length",
    );
    final.usage = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 };
    const { provider } = fixture([final]);
    const frames = await collect(provider);
    expect(frames.some((frame) => frame.nativeOutput !== undefined)).toBe(
      false,
    );
    expect(frames.find((frame) => frame.finishReason)).toMatchObject({
      finishReason: "length",
      rawFinishReason: "length",
      tokenUsage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    });
  });

  it("rejects conflicting detail identities", async () => {
    const { provider } = fixture([
      chunk({
        reasoning_details: [
          { type: "reasoning.encrypted", index: 0, id: "a", data: "opaque" },
        ],
      }),
      chunk(
        {
          reasoning_details: [
            { type: "reasoning.encrypted", index: 0, id: "b", data: "opaque" },
          ],
        },
        "stop",
      ),
    ]);
    await expect(collect(provider)).rejects.toThrow();
  });

  it("does not accept native reasoning before a terminal finish", async () => {
    const { provider } = fixture([
      chunk({
        reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }],
      }),
    ]);
    await expect(collect(provider)).rejects.toThrow();
  });

  it.each([0, 4])(
    "retains reasoning token subset %s without changing total output",
    async (reasoning_tokens) => {
      const final = chunk({ content: "done" }, "stop");
      final.usage = {
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
        completion_tokens_details: { reasoning_tokens },
      };
      const { provider } = fixture([final]);
      const frames = await collect(provider);
      expect(
        frames.find((frame) => frame.reasoningTokens !== undefined)
          ?.reasoningTokens,
      ).toBe(reasoning_tokens);
      expect(frames.find((frame) => frame.finishReason)?.tokenUsage).toEqual({
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
      });
    },
  );
});

it.each([
  {
    tool_calls: [
      {
        index: 0,
        id: "late",
        type: "function",
        function: { name: "late_tool", arguments: "{}" },
      },
    ],
  },
  { content: "late text" },
  { reasoning_content: "late reasoning" },
])("rejects new output after Chat finish: %s", async (delta) => {
  const { provider } = fixture([
    chunk({ reasoning_content: "plan" }),
    chunk({ content: "done" }, "stop"),
    chunk(delta),
  ]);
  await expect(collect(provider)).rejects.toThrow(/after.*finish/i);
});

it("preserves documented ZenMux string indexes and distinct summary/encrypted details at one index", async () => {
  const details = [
    {
      type: "reasoning.summary",
      index: "0",
      format: "openai-responses-v1",
      summary: "plan",
    },
    {
      type: "reasoning.encrypted",
      index: "0",
      id: "reasoning-0",
      format: "openai-responses-v1",
      data: "cipher",
    },
  ];
  const { provider, bodies } = fixture([
    chunk({ reasoning_details: details }, "stop"),
  ]);
  const frames = await collect(provider);
  const output = frames.find((frame) => frame.nativeOutput)?.nativeOutput;
  expect(output).toEqual({
    protocol: "openai-compatible",
    reasoningDetails: details,
  });
  if (output === undefined) throw new Error("Expected native output");
  await collect(provider, {
    ...request,
    messages: [
      {
        role: "assistant",
        content: null,
        modelState: {
          version: 1,
          origin,
          output,
          estimate: { tokens: 8, source: "reasoning" },
        },
      },
    ],
  });
  expect(bodies[1].messages).toEqual([
    { role: "assistant", content: null, reasoning_details: details },
  ]);
});

it.each(["-1", "01", "1.5", "garbage", "", null])(
  "rejects malformed reasoning detail index %s",
  async (index) => {
    const { provider } = fixture([
      chunk(
        {
          reasoning_details: [
            { type: "reasoning.encrypted", index, data: "cipher" },
          ],
        },
        "stop",
      ),
    ]);
    await expect(collect(provider)).rejects.toThrow();
  },
);

it("rejects a late id that aliases another indexed reasoning detail", async () => {
  const { provider } = fixture([
    chunk({
      reasoning_details: [
        { type: "reasoning.encrypted", index: "0", data: "a" },
        { type: "reasoning.encrypted", index: "1", id: "r", data: "b" },
      ],
    }),
    chunk(
      {
        reasoning_details: [
          { type: "reasoning.encrypted", index: "0", id: "r", data: "tail" },
        ],
      },
      "stop",
    ),
  ]);
  await expect(collect(provider)).rejects.toThrow(/identity/);
});
