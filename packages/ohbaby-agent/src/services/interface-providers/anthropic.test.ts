import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "./anthropic.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "./types.js";

function createRawStream(
  events: readonly RawMessageStreamEvent[],
): AsyncGenerator<RawMessageStreamEvent, void, unknown> {
  return (async function* (): AsyncGenerator<
    RawMessageStreamEvent,
    void,
    unknown
  > {
    for (const event of events) {
      yield await Promise.resolve(event);
    }
  })();
}

describe("anthropic provider", () => {
  it("should convert OpenAI-compatible messages and tools to Anthropic params", async () => {
    const provider = createAnthropicProvider({
      id: "anthropic",
      apiKey: "test-key",
      baseUrl: "https://api.anthropic.com",
    });
    const stream = vi.spyOn(provider.client.messages, "stream").mockReturnValue(
      createRawStream([
        {
          type: "message_delta",
          delta: {
            container: null,
            stop_reason: "end_turn",
            stop_details: null,
            stop_sequence: null,
          },
          usage: {
            input_tokens: 12,
            output_tokens: 4,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
          },
        },
      ]),
    );

    const controller = new AbortController();
    const events: InterfaceProviderStreamEvent[] = [];
    const request: InterfaceProviderRequest = {
      model: "claude-3-5-sonnet-latest",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "What is the weather?" },
        {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location":"NYC"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "Sunny",
        },
      ],
      temperature: 0.7,
      maxTokens: 512,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Fetch weather by location",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
              required: ["location"],
            },
          },
        },
      ],
      signal: controller.signal,
    };
    const result = await provider.streamChatCompletion(request);

    for await (const event of result) {
      events.push(event);
    }

    expect(stream).toHaveBeenCalledWith(
      {
        model: "claude-3-5-sonnet-latest",
        system: "You are helpful.",
        messages: [
          {
            role: "user",
            content: "What is the weather?",
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check." },
              {
                type: "tool_use",
                id: "call_1",
                name: "get_weather",
                input: { location: "NYC" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_1",
                content: "Sunny",
              },
            ],
          },
        ],
        max_tokens: 512,
        temperature: 0.7,
        tools: [
          {
            name: "get_weather",
            description: "Fetch weather by location",
            input_schema: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
              required: ["location"],
            },
          },
        ],
      },
      { signal: controller.signal },
    );
    expect(events).toEqual([
      {
        finishReason: "stop",
        rawFinishReason: "end_turn",
        tokenUsage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      },
    ]);
  });

  it("should normalize Anthropic text and tool-use streaming events", async () => {
    const provider = createAnthropicProvider({
      id: "claude",
      apiKey: "test-key",
      baseUrl: "https://api.anthropic.com",
    });
    vi.spyOn(provider.client.messages, "stream").mockReturnValue(
      createRawStream([
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            citations: null,
            type: "text",
            text: "",
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Hello",
          },
        },
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            caller: { type: "direct" },
            type: "tool_use",
            id: "toolu_1",
            name: "get_weather",
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"location":"',
          },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: 'NYC"}',
          },
        },
        {
          type: "message_delta",
          delta: {
            container: null,
            stop_reason: "tool_use",
            stop_details: null,
            stop_sequence: null,
          },
          usage: {
            input_tokens: 20,
            output_tokens: 8,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
          },
        },
      ]),
    );

    const result = await provider.streamChatCompletion({
      model: "claude-3-5-haiku-latest",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.2,
      maxTokens: 128,
    });
    const events: InterfaceProviderStreamEvent[] = [];

    for await (const event of result) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        textDelta: "Hello",
      },
      {
        toolCallDeltas: [
          {
            index: 1,
            id: "toolu_1",
            name: "get_weather",
          },
        ],
      },
      {
        toolCallDeltas: [
          {
            index: 1,
            argumentsDelta: '{"location":"',
          },
        ],
      },
      {
        toolCallDeltas: [
          {
            index: 1,
            argumentsDelta: 'NYC"}',
          },
        ],
      },
      {
        finishReason: "tool_calls",
        rawFinishReason: "tool_use",
        tokenUsage: {
          prompt_tokens: 20,
          completion_tokens: 8,
          total_tokens: 28,
        },
      },
    ]);
  });

  it("should preserve pause_turn as raw finish reason", async () => {
    const provider = createAnthropicProvider({
      id: "anthropic",
      apiKey: "test-key",
      baseUrl: "https://api.anthropic.com",
    });
    vi.spyOn(provider.client.messages, "stream").mockReturnValue(
      createRawStream([
        {
          type: "message_delta",
          delta: {
            container: null,
            stop_reason: "pause_turn",
            stop_details: null,
            stop_sequence: null,
          },
          usage: {
            input_tokens: 5,
            output_tokens: 1,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
          },
        },
      ]),
    );

    const result = await provider.streamChatCompletion({
      model: "claude-3-5-sonnet-latest",
      messages: [{ role: "user", content: "pause" }],
      temperature: 0.2,
      maxTokens: 32,
    });
    const events: InterfaceProviderStreamEvent[] = [];

    for await (const event of result) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        finishReason: "stop",
        rawFinishReason: "pause_turn",
        tokenUsage: {
          prompt_tokens: 5,
          completion_tokens: 1,
          total_tokens: 6,
        },
      },
    ]);
  });

  it("converts newly resolved tool sets on successive requests", async () => {
    const provider = createAnthropicProvider({
      id: "anthropic",
      apiKey: "test-key",
      baseUrl: "https://api.anthropic.com",
    });
    const stream = vi
      .spyOn(provider.client.messages, "stream")
      .mockImplementation(() =>
        createRawStream([
          {
            type: "message_delta",
            delta: {
              container: null,
              stop_reason: "end_turn",
              stop_details: null,
              stop_sequence: null,
            },
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              server_tool_use: null,
            },
          },
        ]),
      );
    const selectTools = {
      type: "function" as const,
      function: {
        name: "select_tools",
        description: "Load an MCP tool.",
        parameters: { type: "object", properties: {} },
      },
    };
    const selectedMcpTool = {
      type: "function" as const,
      function: {
        name: "mcp_s7_example_t6_search",
        description: "MCP tool loaded on demand.",
        parameters: { type: "object", properties: {} },
      },
    };
    const baseRequest = {
      maxTokens: 32,
      messages: [{ role: "user" as const, content: "Continue" }],
      model: "claude-3-5-haiku-latest",
      temperature: 0,
    };

    for (const tools of [[selectTools], [selectTools, selectedMcpTool]]) {
      const result = await provider.streamChatCompletion({
        ...baseRequest,
        tools,
      });
      for await (const _event of result) {
        // Exhaust the stream so each request completes before inspecting calls.
      }
    }

    expect(stream).toHaveBeenCalledTimes(2);
    expect(stream.mock.calls[0]?.[0].tools?.map((tool) => tool.name)).toEqual([
      "select_tools",
    ]);
    expect(stream.mock.calls[1]?.[0].tools?.map((tool) => tool.name)).toEqual([
      "select_tools",
      "mcp_s7_example_t6_search",
    ]);
  });
});
