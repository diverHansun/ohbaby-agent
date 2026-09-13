import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIResponsesProvider } from "./openai-responses.js";
import type { InterfaceProviderRequest } from "./types.js";

const options = { id: "test", apiKey: "test", baseUrl: "http://localhost:1" };
const base = {
  model: "test",
  temperature: 0,
  maxTokens: 32,
  promptCache: { strategy: "observe-only" as const, reason: "test" },
};
afterEach(() => vi.restoreAllMocks());

describe("model request contract", () => {
  it.each(["chat", "anthropic"])(
    "rejects legacy history and custom calls on %s before sending",
    async (kind) => {
      const provider =
        kind === "chat"
          ? createOpenAICompatibleProvider(options)
          : createAnthropicProvider(options);
      if ("chat" in provider.client)
        vi.spyOn(provider.client.chat.completions, "create").mockResolvedValue(
          {} as never,
        );
      else vi.spyOn(provider.client.messages, "stream").mockReturnValue({});
      for (const message of [
        {
          role: "assistant",
          content: "hello",
          toolCalls: [
            { type: "custom", id: "c", custom: { name: "read", input: "x" } },
          ],
        },
        { role: "function", name: "read", content: "legacy" },
        {
          role: "assistant",
          content: "hello",
          function_call: { name: "read", arguments: "{}" },
        },
        { role: "assistant", content: "hello", tool_calls: [] },
      ])
        await expect(
          Promise.resolve().then(() =>
            provider.streamResponse({
              ...base,
              messages: [message],
            } as never),
          ),
        ).rejects.toThrow();
    },
  );
  it("projects flat calls and tools to Chat while preserving raw arguments and rare fields", async () => {
    const provider = createOpenAICompatibleProvider(options);
    const create = vi
      .spyOn(provider.client.chat.completions, "create")
      .mockResolvedValue({} as never);
    await provider.streamResponse({
      ...base,
      messages: [
        {
          role: "system",
          name: "policy",
          content: [
            {
              type: "text",
              text: "",
              cacheControl: { type: "ephemeral", ttl: "5m" },
              prompt_cache_breakpoint: { mode: "explicit" },
            },
          ],
        },
        {
          role: "user",
          name: "reader",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,x", detail: "low" },
            },
            { type: "input_audio", input_audio: { data: "x", format: "wav" } },
            { type: "file", file: { filename: "a" } },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "refusal", refusal: "no" }],
          audio: { id: "audio_1" },
          refusal: null,
          reasoningText: "think",
          toolCalls: [
            { callId: "c", name: "read", argumentsJson: '{ "q": 1 }' },
          ],
        },
        { role: "tool", callId: "c", content: "" },
      ],
      tools: [
        {
          name: "read",
          description: "read",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    expect(create.mock.calls[0]?.[0].messages).toEqual([
      {
        role: "system",
        name: "policy",
        content: [
          {
            type: "text",
            text: "",
            cache_control: { type: "ephemeral", ttl: "5m" },
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
      },
      {
        role: "user",
        name: "reader",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,x", detail: "low" },
          },
          { type: "input_audio", input_audio: { data: "x", format: "wav" } },
          { type: "file", file: { filename: "a" } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "refusal", refusal: "no" }],
        audio: { id: "audio_1" },
        refusal: null,
        reasoning_content: "think",
        tool_calls: [
          {
            id: "c",
            type: "function",
            function: { name: "read", arguments: '{ "q": 1 }' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c", content: "" },
    ]);
    expect(create.mock.calls[0]?.[0].tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "read",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });

  it.each([
    [[], "[]"],
    [[{ type: "text", text: "" }], '[{"type":"text","text":""}]'],
    [
      [
        {
          type: "text",
          cacheControl: { type: "ephemeral", ttl: "5m" },
          text: "",
          prompt_cache_breakpoint: { mode: "explicit" },
        },
      ],
      '[{"type":"text","cache_control":{"type":"ephemeral","ttl":"5m"},"text":"","prompt_cache_breakpoint":{"mode":"explicit"}}]',
    ],
  ])(
    "preserves Anthropic empty tool-result JSON fallback %j",
    async (content, expected) => {
      const provider = createAnthropicProvider(options);
      const create = vi
        .spyOn(provider.client.messages, "stream")
        .mockReturnValue({});
      await provider.streamResponse({
        ...base,
        messages: [{ role: "tool", callId: "c", content }],
      } as InterfaceProviderRequest);
      expect(create.mock.calls[0]?.[0].messages).toEqual([
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "c", content: expected },
          ],
        },
      ]);
    },
  );

  it("projects flat Responses calls and tools with raw schema and arguments", async () => {
    const provider = createOpenAIResponsesProvider(options);
    const create = vi
      .spyOn(provider.client.responses, "create")
      .mockResolvedValue({} as never);
    await provider.streamResponse({
      ...base,
      messages: [
        {
          role: "assistant",
          content: null,
          toolCalls: [{ callId: "c", name: "read", argumentsJson: "{ }" }],
        },
        { role: "tool", callId: "c", content: "" },
      ],
      tools: [{ name: "read", inputSchema: { type: "object" } }],
    });
    expect(create.mock.calls[0]?.[0].input).toEqual([
      { type: "function_call", call_id: "c", name: "read", arguments: "{ }" },
      { type: "function_call_output", call_id: "c", output: "" },
    ]);
    expect(create.mock.calls[0]?.[0].tools).toEqual([
      {
        type: "function",
        name: "read",
        parameters: { type: "object" },
        strict: false,
      },
    ]);
  });
});
