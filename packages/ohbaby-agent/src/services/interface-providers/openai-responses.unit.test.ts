import OpenAI, { APIUserAbortError } from "openai";
import type {
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { createInterfaceProvider } from "./index.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "./types.js";

const request: InterfaceProviderRequest = {
  model: "responses-model",
  messages: [{ role: "user", content: "hello" }],
  temperature: 0.3,
  maxTokens: 128,
  promptCache: {
    strategy: "openai-keyed-implicit",
    key: "must-not-leak",
    reason: "test",
  },
};

function setup(events: unknown[] = []): {
  provider: ReturnType<typeof createInterfaceProvider>;
  create: MockInstance<OpenAI["responses"]["create"]>;
} {
  const provider = createInterfaceProvider({
    id: "responses",
    interfaceProvider: "openai-responses",
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
  });
  if (!(provider.client instanceof OpenAI))
    throw new Error("Expected OpenAI SDK client");
  const create = vi
    .spyOn(provider.client.responses, "create")
    .mockResolvedValue(
      (async function* (): AsyncGenerator {
        for (const event of events) yield await Promise.resolve(event);
      })() as unknown as Awaited<
        ReturnType<typeof provider.client.responses.create>
      >,
    );
  return { provider, create };
}

function response(
  output: unknown[],
  status = "completed",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "resp-1",
    status,
    output,
    store: false,
    previous_response_id: null,
    ...extra,
  };
}
function terminal(
  output: unknown[],
  status = "completed",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: `response.${status}`,
    response: response(output, status, extra),
  };
}
function part(text = ""): Record<string, unknown> {
  return { type: "output_text", text, annotations: [], logprobs: [] };
}
function message(
  text = "hello",
  status = "completed",
): Record<string, unknown> {
  return {
    id: "msg-1",
    type: "message",
    role: "assistant",
    status,
    content: [part(text)],
  };
}
function call(
  id = "fn-1",
  callId = "call-1",
  args = '{"q":"a"}',
  status = "completed",
): Record<string, unknown> {
  return {
    id,
    type: "function_call",
    call_id: callId,
    name: "lookup",
    arguments: args,
    status,
  };
}
function textEvents(
  text = "hello",
  status = "completed",
  outputIndex = 0,
): Record<string, unknown>[] {
  const ref = { item_id: "msg-1", output_index: outputIndex, content_index: 0 };
  return [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...message("", "in_progress"), content: [] },
    },
    { type: "response.content_part.added", ...ref, part: part() },
    { type: "response.output_text.delta", ...ref, delta: text, logprobs: [] },
    { type: "response.output_text.done", ...ref, text, logprobs: [] },
    { type: "response.content_part.done", ...ref, part: part(text) },
    {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: message(text, status),
    },
  ];
}
function functionEvents(
  id = "fn-1",
  callId = "call-1",
  outputIndex = 3,
): Record<string, unknown>[] {
  return [
    {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: call(id, callId, "", "in_progress"),
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: outputIndex,
      item_id: id,
      delta: '{"q":',
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: outputIndex,
      item_id: id,
      delta: '"a"}',
    },
    {
      type: "response.function_call_arguments.done",
      output_index: outputIndex,
      item_id: id,
      name: "lookup",
      arguments: '{"q":"a"}',
    },
    {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: call(id, callId),
    },
  ];
}

async function collect(
  events: unknown[],
): Promise<InterfaceProviderStreamEvent[]> {
  const { provider } = setup(events);
  const output: InterfaceProviderStreamEvent[] = [];
  for await (const event of await provider.streamChatCompletion(request))
    output.push(event);
  return output;
}

describe("Responses request projection", () => {
  it("moves all system strings into ordered instructions and projects conversation/function roundtrips", async () => {
    const { provider, create } = setup();
    await provider.streamChatCompletion({
      ...request,
      messages: [
        { role: "system", content: "base" },
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "checking",
          tool_calls: [
            {
              id: "call-a",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"a"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-a", content: "result" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-b",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        { role: "system", content: "tail directives" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up a value",
            parameters: { type: "object" },
          },
        },
      ],
    });
    expect(provider.kind).toBe("openai-responses");
    expect(create.mock.calls[0]?.[0]).toEqual({
      model: "responses-model",
      instructions: "base\n\ntail directives",
      temperature: 0.3,
      max_output_tokens: 128,
      stream: true,
      store: false,
      input: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "checking" },
        {
          type: "function_call",
          call_id: "call-a",
          name: "lookup",
          arguments: '{"q":"a"}',
        },
        { type: "function_call_output", call_id: "call-a", output: "result" },
        {
          type: "function_call",
          call_id: "call-b",
          name: "lookup",
          arguments: "{}",
        },
      ],
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Look up a value",
          parameters: { type: "object" },
          strict: false,
        },
      ],
    });
  });

  it("omits absent instructions and tools and projects no cache or continuation controls", async () => {
    const { provider, create } = setup();
    await provider.streamChatCompletion(request);
    expect(create.mock.calls[0]?.[0]).toEqual({
      model: "responses-model",
      input: [{ role: "user", content: "hello" }],
      temperature: 0.3,
      max_output_tokens: 128,
      stream: true,
      store: false,
    });
  });

  const messages = [
    { role: "developer", content: "unsupported" },
    { role: "function", name: "legacy", content: "x" },
    { role: "user", content: [{ type: "text", text: "text" }] },
    { role: "assistant", content: "x", audio: null },
    { role: "assistant", content: "x", refusal: null },
    {
      role: "assistant",
      content: "x",
      function_call: { name: "legacy", arguments: "{}" },
    },
    { role: "user", content: "x", name: "named" },
    { role: "assistant", content: "x", reasoning_content: "secret" },
    { role: "system", content: "x", unknown: undefined },
    { role: "tool", content: "x", tool_call_id: "" },
    { role: "assistant", content: null },
    {
      role: "assistant",
      content: "x",
      tool_calls: [{ type: "custom", id: "a", custom: {} }],
    },
    {
      role: "assistant",
      tool_calls: [
        {
          type: "function",
          id: "a",
          extra: true,
          function: { name: "lookup", arguments: "{}" },
        },
      ],
    },
    {
      role: "assistant",
      tool_calls: [
        {
          type: "function",
          id: "a",
          function: { name: "lookup", arguments: "{}", extra: true },
        },
      ],
    },
  ];
  it.each(messages)(
    "rejects unsupported message shape %j before creating a request",
    async (message) => {
      const { provider, create } = setup();
      await expect(
        provider.streamChatCompletion({
          ...request,
          messages: [message as never],
        }),
      ).rejects.toThrow(/Responses request/u);
      expect(create).not.toHaveBeenCalled();
    },
  );
  it.each([
    { type: "custom", custom: { name: "x" } },
    { type: "function", extra: true, function: { name: "x", parameters: {} } },
    { type: "function", function: { name: "x", parameters: {}, strict: true } },
    { type: "function", function: { name: "", parameters: {} } },
  ])(
    "rejects unsupported tool shape %j before creating a request",
    async (tool) => {
      const { provider, create } = setup();
      await expect(
        provider.streamChatCompletion({ ...request, tools: [tool as never] }),
      ).rejects.toThrow(/Responses request/u);
      expect(create).not.toHaveBeenCalled();
    },
  );
});

describe("Responses state machine and terminal equality", () => {
  const text = (): Record<string, unknown>[] => textEvents();
  const fn = (): Record<string, unknown>[] => functionEvents();
  const cases: [string, () => unknown[]][] = [
    [
      "empty response id",
      (): unknown[] => [
        ...text(),
        terminal([message()], "completed", { id: "" }),
      ],
    ],
    [
      "changing response id",
      (): unknown[] => [
        {
          type: "response.created",
          response: response([], "in_progress", { id: "other" }),
        },
        ...text(),
        terminal([message()]),
      ],
    ],
    [
      "lifecycle status mismatch",
      (): unknown[] => [
        { type: "response.queued", response: response([], "in_progress") },
        ...text(),
        terminal([message()]),
      ],
    ],
    [
      "terminal status mismatch",
      (): unknown[] => [
        ...text(),
        {
          type: "response.completed",
          response: response([message()], "in_progress"),
        },
      ],
    ],
    [
      "duplicate item id",
      (): unknown[] => [
        text()[0],
        { ...text()[0], output_index: 3 },
        ...text().slice(1),
        terminal([message()]),
      ],
    ],
    [
      "duplicate output index",
      (): unknown[] => [
        text()[0],
        { ...fn()[0], output_index: 0 },
        ...text().slice(1),
        terminal([message()]),
      ],
    ],
    [
      "invalid output index",
      (): unknown[] => [
        { ...text()[0], output_index: -1 },
        ...text().slice(1),
        terminal([message()]),
      ],
    ],
    [
      "item done without added",
      (): unknown[] => [text()[5], terminal([message()])],
    ],
    [
      "duplicate item done",
      (): unknown[] => [...text(), text()[5], terminal([message()])],
    ],
    [
      "missing item done",
      (): unknown[] => [...text().slice(0, 5), terminal([message()])],
    ],
    [
      "text delta before item added",
      (): unknown[] => [text()[2], ...text(), terminal([message()])],
    ],
    [
      "text delta before part added",
      (): unknown[] => [
        text()[0],
        text()[2],
        ...text().slice(1),
        terminal([message()]),
      ],
    ],
    [
      "text delta after text done",
      (): unknown[] => [
        ...text().slice(0, 4),
        text()[2],
        ...text().slice(4),
        terminal([message()]),
      ],
    ],
    [
      "text delta after item done",
      (): unknown[] => [...text(), text()[2], terminal([message()])],
    ],
    [
      "text done mismatch",
      (): unknown[] => [
        ...text().slice(0, 3),
        { ...text()[3], text: "different" },
        ...text().slice(4),
        terminal([message()]),
      ],
    ],
    [
      "duplicate text done",
      (): unknown[] => [
        ...text().slice(0, 4),
        text()[3],
        ...text().slice(4),
        terminal([message()]),
      ],
    ],
    [
      "part done before part added",
      (): unknown[] => [
        text()[0],
        text()[4],
        ...text().slice(1),
        terminal([message()]),
      ],
    ],
    [
      "part done mismatch",
      (): unknown[] => [
        ...text().slice(0, 4),
        { ...text()[4], part: part("different") },
        text()[5],
        terminal([message()]),
      ],
    ],
    [
      "duplicate part added",
      (): unknown[] => [
        text()[0],
        text()[1],
        text()[1],
        ...text().slice(2),
        terminal([message()]),
      ],
    ],
    [
      "second content index",
      (): unknown[] => [
        text()[0],
        { ...text()[1], content_index: 1 },
        ...text().slice(2),
        terminal([message()]),
      ],
    ],
    [
      "delta wrong content index",
      (): unknown[] => [
        ...text().slice(0, 2),
        { ...text()[2], content_index: 1 },
        ...text().slice(3),
        terminal([message()]),
      ],
    ],
    [
      "delta wrong output index",
      (): unknown[] => [
        ...text().slice(0, 2),
        { ...text()[2], output_index: 9 },
        ...text().slice(3),
        terminal([message()]),
      ],
    ],
    [
      "delta wrong item id",
      (): unknown[] => [
        ...text().slice(0, 2),
        { ...text()[2], item_id: "other" },
        ...text().slice(3),
        terminal([message()]),
      ],
    ],
    [
      "missing content part",
      (): unknown[] => [text()[0], text()[5], terminal([message()])],
    ],
    [
      "missing part done",
      (): unknown[] => [
        ...text().slice(0, 4),
        text()[5],
        terminal([message()]),
      ],
    ],
    [
      "prefilled added message",
      (): unknown[] => [
        { ...text()[0], item: message("hello", "in_progress") },
        ...text().slice(1),
        terminal([message()]),
      ],
    ],
    [
      "prefilled added part",
      (): unknown[] => [
        text()[0],
        { ...text()[1], part: part("hello") },
        ...text().slice(2),
        terminal([message()]),
      ],
    ],
    [
      "message added completed",
      (): unknown[] => [
        { ...text()[0], item: { ...message(), content: [] } },
        ...text().slice(1),
        terminal([message()]),
      ],
    ],
    [
      "message done in progress",
      (): unknown[] => [
        ...text().slice(0, 5),
        { ...text()[5], item: message("hello", "in_progress") },
        terminal([message()]),
      ],
    ],
    [
      "message terminal status inconsistent",
      (): unknown[] => [
        ...textEvents("hello", "incomplete"),
        terminal([message()]),
      ],
    ],
    [
      "call delta before added",
      (): unknown[] => [fn()[1], ...fn(), terminal([call()])],
    ],
    [
      "call delta after arguments done",
      (): unknown[] => [
        ...fn().slice(0, 4),
        fn()[1],
        fn()[4],
        terminal([call()]),
      ],
    ],
    [
      "duplicate arguments done",
      (): unknown[] => [
        ...fn().slice(0, 4),
        fn()[3],
        fn()[4],
        terminal([call()]),
      ],
    ],
    [
      "arguments done mismatch",
      (): unknown[] => [
        ...fn().slice(0, 3),
        { ...fn()[3], arguments: "different" },
        fn()[4],
        terminal([call()]),
      ],
    ],
    [
      "call id rebound",
      (): unknown[] => [
        ...fn().slice(0, 4),
        { ...fn()[4], item: call("fn-1", "other") },
        terminal([call()]),
      ],
    ],
    [
      "call name rebound",
      (): unknown[] => [
        ...fn().slice(0, 4),
        { ...fn()[4], item: { ...call(), name: "other" } },
        terminal([call()]),
      ],
    ],
    [
      "call id reused",
      (): unknown[] => [
        fn()[0],
        functionEvents("fn-2", "call-1", 8)[0],
        ...fn().slice(1),
        terminal([call()]),
      ],
    ],
    [
      "call added completed",
      (): unknown[] => [
        { ...fn()[0], item: call() },
        ...fn().slice(1),
        terminal([call()]),
      ],
    ],
    [
      "call added prefilled arguments",
      (): unknown[] => [
        { ...fn()[0], item: call("fn-1", "call-1", "{}", "in_progress") },
        ...fn().slice(1),
        terminal([call()]),
      ],
    ],
    [
      "call done incomplete",
      (): unknown[] => [
        ...fn().slice(0, 4),
        { ...fn()[4], item: call("fn-1", "call-1", '{"q":"a"}', "incomplete") },
        terminal([call()]),
      ],
    ],
    [
      "call done arguments mismatch",
      (): unknown[] => [
        ...fn().slice(0, 4),
        { ...fn()[4], item: call("fn-1", "call-1", "different") },
        terminal([call()]),
      ],
    ],
    ["missing terminal", (): unknown[] => text()],
    [
      "duplicate terminal",
      (): unknown[] => [
        ...text(),
        terminal([message()]),
        terminal([message()]),
      ],
    ],
    [
      "event after terminal",
      (): unknown[] => [
        ...text(),
        terminal([message()]),
        { type: "response.in_progress", response: response([], "in_progress") },
      ],
    ],
    ["terminal missing output", (): unknown[] => [...text(), terminal([])]],
    [
      "terminal extra output",
      (): unknown[] => [...text(), terminal([message(), call()])],
    ],
    [
      "terminal duplicate output",
      (): unknown[] => [...fn(), terminal([call(), call()])],
    ],
    [
      "terminal reordered output",
      (): unknown[] => [...text(), ...fn(), terminal([call(), message()])],
    ],
    [
      "terminal changed item id",
      (): unknown[] => [...text(), terminal([{ ...message(), id: "other" }])],
    ],
    [
      "terminal changed item type",
      (): unknown[] => [...text(), terminal([{ ...call(), id: "msg-1" }])],
    ],
    [
      "terminal text mismatch",
      (): unknown[] => [...text(), terminal([message("different")])],
    ],
    [
      "terminal arguments mismatch",
      (): unknown[] => [
        ...fn(),
        terminal([call("fn-1", "call-1", "different")]),
      ],
    ],
    [
      "terminal call id mismatch",
      (): unknown[] => [...fn(), terminal([call("fn-1", "other")])],
    ],
    [
      "terminal call name mismatch",
      (): unknown[] => [...fn(), terminal([{ ...call(), name: "other" }])],
    ],
    [
      "incomplete terminal text mismatch",
      (): unknown[] => [
        ...textEvents("partial", "incomplete"),
        terminal([message("different", "incomplete")], "incomplete", {
          incomplete_details: { reason: "max_output_tokens" },
        }),
      ],
    ],
    [
      "multiple message items",
      (): unknown[] => [
        ...text(),
        {
          ...text()[0],
          output_index: 2,
          item: { ...message("", "in_progress"), id: "msg-2", content: [] },
        },
        terminal([message()]),
      ],
    ],
    [
      "message after function in output order",
      (): unknown[] => [
        ...fn(),
        ...textEvents("hello", "completed", 8),
        terminal([call(), message()]),
      ],
    ],
    [
      "function before message in output order",
      (): unknown[] => [
        ...textEvents("hello", "completed", 8),
        ...fn(),
        terminal([call(), message()]),
      ],
    ],
  ];
  it.each(cases)(
    "rejects %s without yielding a success terminal",
    async (_name, build) => {
      const { provider } = setup(build());
      const output: InterfaceProviderStreamEvent[] = [];
      await expect(
        (async (): Promise<void> => {
          for await (const event of await provider.streamChatCompletion(
            request,
          ))
            output.push(event);
        })(),
      ).rejects.toThrow(/Responses/u);
      expect(
        output.filter((event) => event.finishReason !== undefined),
      ).toEqual([]);
    },
  );
});

describe("Responses mapped stream", () => {
  it("emits text once and a single stop carrying inclusive usage", async () => {
    expect(
      await collect([
        { type: "response.created", response: response([], "in_progress") },
        { type: "response.in_progress", response: response([], "in_progress") },
        ...textEvents(),
        terminal([message()], "completed", {
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            input_tokens_details: { cached_tokens: 40 },
          },
        }),
      ]),
    ).toEqual([
      { textDelta: "hello" },
      {
        finishReason: "stop",
        rawFinishReason: "completed",
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          inputBreakdown: {
            uncached: 60,
            cacheRead: 40,
            cacheWrite: 0,
            observed: { cacheRead: true, cacheWrite: false },
          },
        },
      },
    ]);
  });
  it("binds parallel function indices by added order while terminal order follows output_index", async () => {
    const a = functionEvents("fn-a", "call-a", 9);
    const b = functionEvents("fn-b", "call-b", 3);
    expect(
      await collect([
        ...textEvents(),
        a[0],
        b[0],
        ...b.slice(1),
        ...a.slice(1),
        terminal([message(), call("fn-b", "call-b"), call("fn-a", "call-a")]),
      ]),
    ).toEqual([
      { textDelta: "hello" },
      { toolCallDeltas: [{ index: 0, id: "call-a", name: "lookup" }] },
      { toolCallDeltas: [{ index: 1, id: "call-b", name: "lookup" }] },
      { toolCallDeltas: [{ index: 1, argumentsDelta: '{"q":' }] },
      { toolCallDeltas: [{ index: 1, argumentsDelta: '"a"}' }] },
      { toolCallDeltas: [{ index: 0, argumentsDelta: '{"q":' }] },
      { toolCallDeltas: [{ index: 0, argumentsDelta: '"a"}' }] },
      { finishReason: "tool_calls", rawFinishReason: "completed" },
    ]);
  });
  it.each([
    ["max_output_tokens", "length"],
    ["content_filter", "content_filter"],
  ])("maps message-only incomplete %s", async (reason, finishReason) => {
    expect(
      await collect([
        ...textEvents("partial", "incomplete"),
        terminal([message("partial", "incomplete")], "incomplete", {
          incomplete_details: { reason },
        }),
      ]),
    ).toEqual([
      { textDelta: "partial" },
      { finishReason, rawFinishReason: reason },
    ]);
  });
  it("preserves direct/null caller and synchronous function output", async () => {
    const events = functionEvents();
    const final = { ...call(), async: false, caller: { type: "direct" } };
    events[0] = {
      ...events[0],
      item: { ...call("fn-1", "call-1", "", "in_progress"), caller: null },
    };
    events[4] = { ...events[4], item: final };
    expect((await collect([...events, terminal([final])])).at(-1)).toEqual({
      finishReason: "tool_calls",
      rawFinishReason: "completed",
    });
  });
});

const rejectedEvents = [
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.refusal.delta",
  "response.refusal.done",
  "response.output_text.annotation.added",
  "error",
  "response.failed",
  "response.audio.delta",
  "response.audio.done",
  "response.audio.transcript.delta",
  "response.audio.transcript.done",
  "response.code_interpreter_call_code.delta",
  "response.code_interpreter_call_code.done",
  "response.code_interpreter_call.in_progress",
  "response.code_interpreter_call.interpreting",
  "response.code_interpreter_call.completed",
  "response.file_search_call.in_progress",
  "response.file_search_call.searching",
  "response.file_search_call.completed",
  "response.web_search_call.in_progress",
  "response.web_search_call.searching",
  "response.web_search_call.completed",
  "response.image_generation_call.in_progress",
  "response.image_generation_call.generating",
  "response.image_generation_call.partial_image",
  "response.image_generation_call.completed",
  "response.custom_tool_call_input.delta",
  "response.custom_tool_call_input.done",
  "response.mcp_call_arguments.delta",
  "response.mcp_call_arguments.done",
  "response.mcp_call.in_progress",
  "response.mcp_call.completed",
  "response.mcp_call.failed",
  "response.mcp_list_tools.in_progress",
  "response.mcp_list_tools.completed",
  "response.mcp_list_tools.failed",
  "response.shell_call_command.added",
  "response.shell_call_command.delta",
  "response.shell_call_command.done",
  "response.shell_call_output_content.delta",
  "response.shell_call_output_content.done",
] as const satisfies readonly ResponseStreamEvent["type"][];
const rejectedItems = [
  "file_search_call",
  "function_call_output",
  "web_search_call",
  "computer_call",
  "computer_call_output",
  "reasoning",
  "program",
  "program_output",
  "tool_search_call",
  "tool_search_output",
  "additional_tools",
  "compaction",
  "image_generation_call",
  "code_interpreter_call",
  "local_shell_call",
  "local_shell_call_output",
  "shell_call",
  "shell_call_output",
  "apply_patch_call",
  "apply_patch_call_output",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
  "mcp_approval_response",
  "custom_tool_call",
  "custom_tool_call_output",
] as const satisfies readonly ResponseOutputItem["type"][];

describe("Responses response status consistency", () => {
  it.each([
    ["text", "max_output_tokens"],
    ["text", "content_filter"],
    ["text", "future_reason"],
    ["function", "max_output_tokens"],
    ["function", "content_filter"],
    ["function", "future_reason"],
  ])(
    "rejects completed %s with incomplete reason %s without releasing terminal",
    async (kind, reason) => {
      const { provider } = setup([
        ...(kind === "text" ? textEvents() : functionEvents()),
        terminal([kind === "text" ? message() : call()], "completed", {
          incomplete_details: { reason },
        }),
      ]);
      const output: InterfaceProviderStreamEvent[] = [];
      await expect(
        (async (): Promise<void> => {
          for await (const event of await provider.streamChatCompletion(
            request,
          ))
            output.push(event);
        })(),
      ).rejects.toThrow(/incomplete_details/u);
      expect(
        output.filter((event) => event.finishReason !== undefined),
      ).toEqual([]);
    },
  );
  it.each([
    ["response.created", "max_output_tokens"],
    ["response.created", "future_reason"],
    ["response.in_progress", "max_output_tokens"],
    ["response.in_progress", "future_reason"],
    ["response.queued", "max_output_tokens"],
    ["response.queued", "future_reason"],
  ])(
    "rejects lifecycle %s with contradictory incomplete reason %s",
    async (type, reason) => {
      await expect(
        collect([
          {
            type,
            response: response(
              [],
              type === "response.queued" ? "queued" : "in_progress",
              { incomplete_details: { reason } },
            ),
          },
          ...textEvents(),
          terminal([message()]),
        ]),
      ).rejects.toThrow(/incomplete_details/u);
    },
  );
  it.each([null, undefined])(
    "accepts nullish incomplete_details on completed snapshots: %s",
    async (details) => {
      expect(
        (
          await collect([
            ...functionEvents(),
            terminal([call()], "completed", { incomplete_details: details }),
          ])
        ).at(-1)?.finishReason,
      ).toBe("tool_calls");
    },
  );
});

describe("Responses rejected and unknown capabilities", () => {
  it.each(["response.created", "response.in_progress", "response.queued"])(
    "rejects hidden output items in lifecycle snapshots: %s",
    async (type) => {
      await expect(
        collect([
          {
            type,
            response: response(
              [{ type: "reasoning", id: "hidden" }],
              type === "response.queued" ? "queued" : "in_progress",
            ),
          },
          ...functionEvents(),
          terminal([call()]),
        ]),
      ).rejects.toThrow(/Responses/u);
    },
  );
  it("rejects completed response failure metadata", async () => {
    await expect(
      collect([
        ...functionEvents(),
        terminal([call()], "completed", {
          error: { code: "server_error", message: "failure" },
        }),
      ]),
    ).rejects.toThrow(/Responses/u);
  });
  it.each([...rejectedEvents, "response.future_event"])(
    "rejects event %s even after function deltas",
    async (type) => {
      await expect(
        collect([...functionEvents(), { type }, terminal([call()])]),
      ).rejects.toThrow(type);
    },
  );
  it.each([...rejectedItems, "future_item"])(
    "rejects output item %s at added, done and terminal",
    async (type) => {
      const item = { type, id: "unsupported", status: "completed" };
      await expect(
        collect([
          { type: "response.output_item.added", output_index: 3, item },
          terminal([item]),
        ]),
      ).rejects.toThrow(type);
      await expect(
        collect([
          ...functionEvents(),
          { type: "response.output_item.done", output_index: 3, item },
          terminal([call()]),
        ]),
      ).rejects.toThrow(type);
      await expect(
        collect([...functionEvents(), terminal([item])]),
      ).rejects.toThrow(type);
    },
  );
  it.each([
    { phase: "commentary" },
    { phase: "final_answer" },
    { phase: "" },
    { role: "user" },
  ])(
    "rejects unsupported message fields at every item stage: %j",
    async (fields) => {
      for (const location of ["added", "done", "terminal"]) {
        const events = textEvents();
        const final = { ...message(), ...fields };
        if (location === "added")
          events[0] = {
            ...events[0],
            item: { ...message("", "in_progress"), ...fields, content: [] },
          };
        if (location === "done") events[5] = { ...events[5], item: final };
        await expect(
          collect([
            ...events,
            terminal([location === "terminal" ? final : message()]),
          ]),
        ).rejects.toThrow(/Responses/u);
      }
    },
  );
  it.each([
    { async: true },
    { async: null },
    { namespace: "x" },
    { namespace: undefined },
    { caller: { type: "program", caller_id: "program-1" } },
    { caller: { type: "unknown" } },
    { call_id: "" },
    { name: "" },
  ])(
    "rejects unsupported function fields at every item stage: %j",
    async (fields) => {
      for (const location of ["added", "done", "terminal"]) {
        const events = functionEvents();
        const final = { ...call(), ...fields };
        if (location === "added")
          events[0] = {
            ...events[0],
            item: { ...call("fn-1", "call-1", "", "in_progress"), ...fields },
          };
        if (location === "done") events[4] = { ...events[4], item: final };
        await expect(
          collect([
            ...events,
            terminal([location === "terminal" ? final : call()]),
          ]),
        ).rejects.toThrow(/Responses/u);
      }
    },
  );
  it.each([
    { type: "refusal", refusal: "no" },
    { type: "reasoning_text", text: "reasoning" },
    { type: "future_content" },
    { ...part("hello"), annotations: [{ type: "url_citation" }] },
    { ...part("hello"), logprobs: [{ token: "hello" }] },
  ])(
    "rejects unsupported content at part/done/terminal boundaries: %j",
    async (content) => {
      for (const location of [
        "part-added",
        "part-done",
        "item-done",
        "terminal",
      ]) {
        const events = textEvents();
        const final = { ...message(), content: [content] };
        if (location === "part-added")
          events[1] = { ...events[1], part: { ...content, text: "" } };
        if (location === "part-done")
          events[4] = { ...events[4], part: content };
        if (location === "item-done") events[5] = { ...events[5], item: final };
        await expect(
          collect([
            ...events,
            terminal([location === "terminal" ? final : message()]),
          ]),
        ).rejects.toThrow(/Responses/u);
      }
    },
  );
  it.each([2, 3])(
    "rejects nonempty logprobs in text event at index %i",
    async (index) => {
      const events = textEvents();
      events[index] = { ...events[index], logprobs: [{ token: "hello" }] };
      await expect(collect([...events, terminal([message()])])).rejects.toThrow(
        /logprobs/u,
      );
    },
  );
  it.each([{ previous_response_id: "old" }, { store: true }])(
    "rejects stateful response hints on lifecycle and terminal: %j",
    async (fields) => {
      await expect(
        collect([
          {
            type: "response.created",
            response: response([], "in_progress", fields),
          },
          ...textEvents(),
          terminal([message()]),
        ]),
      ).rejects.toThrow(/Responses/u);
      await expect(
        collect([...textEvents(), terminal([message()], "completed", fields)]),
      ).rejects.toThrow(/Responses/u);
    },
  );
  it.each([
    undefined,
    null,
    {},
    { reason: "future_reason" },
    { reason: "max_messages" },
    { reason: "steered" },
  ])("rejects unsupported incomplete reason %j", async (incompleteDetails) => {
    await expect(
      collect([
        ...textEvents("partial", "incomplete"),
        terminal([message("partial", "incomplete")], "incomplete", {
          incomplete_details: incompleteDetails,
        }),
      ]),
    ).rejects.toThrow(/incomplete/u);
  });
  it.each(["max_output_tokens", "content_filter"])(
    "rejects any incomplete function call for reason %s",
    async (reason) => {
      await expect(
        collect([
          ...functionEvents(),
          terminal([call()], "incomplete", { incomplete_details: { reason } }),
        ]),
      ).rejects.toThrow(/incomplete/u);
    },
  );
  it("accepts a queued lifecycle and null message phase without emitting lifecycle events", async () => {
    const events = textEvents();
    events[0] = {
      ...events[0],
      item: { ...message("", "in_progress"), content: [], phase: null },
    };
    events[5] = { ...events[5], item: { ...message(), phase: null } };
    expect(
      await collect([
        { type: "response.queued", response: response([], "queued") },
        ...events,
        terminal([{ ...message(), phase: null }]),
      ]),
    ).toEqual([
      { textDelta: "hello" },
      { finishReason: "stop", rawFinishReason: "completed" },
    ]);
  });
});

describe("Responses cancellation", () => {
  it("rejects a pre-aborted request without network activity as an abort error", async () => {
    const { provider, create } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.streamChatCompletion({ ...request, signal: controller.signal }),
    ).rejects.toSatisfy((error: unknown) => provider.isAbortError(error));
    expect(create).not.toHaveBeenCalled();
  });
  it("recognizes SDK abort errors without classifying ordinary failures as cancellation", () => {
    const { provider } = setup();
    expect(provider.isAbortError(new APIUserAbortError())).toBe(true);
    expect(provider.isAbortError(new Error("failure"))).toBe(false);
  });
  it("preserves an SDK stream abort after function deltas", async () => {
    const { provider, create } = setup();
    const abort = new APIUserAbortError();
    create.mockResolvedValueOnce(
      (async function* (): AsyncGenerator {
        for (const event of functionEvents().slice(0, 2))
          yield await Promise.resolve(event);
        throw abort;
      })() as never,
    );
    const output: InterfaceProviderStreamEvent[] = [];
    await expect(
      (async (): Promise<void> => {
        for await (const event of await provider.streamChatCompletion(request))
          output.push(event);
      })(),
    ).rejects.toBe(abort);
    expect(output.some((event) => event.finishReason !== undefined)).toBe(
      false,
    );
    expect(provider.isAbortError(abort)).toBe(true);
  });
  it("turns the SDK's silently closed aborted stream into cancellation", async () => {
    const { provider, create } = setup();
    const controller = new AbortController();
    create.mockResolvedValueOnce(
      (async function* (): AsyncGenerator {
        for (const event of functionEvents().slice(0, 2))
          yield await Promise.resolve(event);
        controller.abort();
      })() as never,
    );
    await expect(
      (async (): Promise<void> => {
        for await (const _event of await provider.streamChatCompletion({
          ...request,
          signal: controller.signal,
        })) {
          /* consume */
        }
      })(),
    ).rejects.toSatisfy((error: unknown) => provider.isAbortError(error));
    expect(create.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
