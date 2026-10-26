import { createTestContextManager as createContextManager } from "../testing/model-fixtures.js";
import OpenAI from "openai";
import { createBus } from "../../bus/index.js";
import { createContextSummaryClient } from "../../adapters/ui-runtime/prompt-context.js";

import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../message/index.js";
import { createAnthropicProvider } from "ohbaby-llm";
import { createOpenAIResponsesProvider } from "ohbaby-llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleProvider } from "ohbaby-llm";
import {
  isRetryableProviderError,
  ProviderRetryExhaustedError,
  ProviderStreamInterruptedError,
} from "ohbaby-llm";
import { resolvePreparedRequestSettings, streamResponse } from "ohbaby-llm";
import type { LLMClientInstance, StreamingResponse } from "ohbaby-llm";

// Exercise the installed SDK, production adapter and project retry loop together.
// Only HTTP is replaced; production SDK settings and project retry policy apply.
const protocols = [
  "openai-compatible",
  "openai-responses",
  "anthropic",
] as const;
function fixture(
  reply: (attempt: number) => Response | Promise<Response>,
  protocol: (typeof protocols)[number] = "openai-compatible",
): {
  client: LLMClientInstance;
  attempts: { providerCall: number; at: number }[];
  providerCalls: () => number;
} {
  let providerCalls = 0;
  const attempts: { providerCall: number; at: number }[] = [];
  vi.stubGlobal("fetch", async () => {
    attempts.push({ providerCall: providerCalls, at: Date.now() });
    return reply(attempts.length);
  });
  const createProvider =
    protocol === "anthropic"
      ? createAnthropicProvider
      : protocol === "openai-responses"
        ? createOpenAIResponsesProvider
        : createOpenAICompatibleProvider;
  const provider = createProvider({
    id: "sdk-retry-fixture",
    apiKey: "local-fixture-only",
    baseUrl: "https://sdk-retry.invalid/v1",
  });
  const original = provider.streamResponse.bind(provider);
  vi.spyOn(provider, "streamResponse").mockImplementation((request) => {
    providerCalls += 1;
    return original(request);
  });
  return {
    client: {
      provider,
      config: {
        provider: "sdk-retry-fixture",
        model: "fixture",
        baseUrl: "https://sdk-retry.invalid/v1",
        interfaceProvider: protocol,
        maxTokens: 128,
        promptCache: "disabled",
        modelProfiles: [
          {
            model: "fixture",
            contextWindowTokens: 128000,
            reasoningCapabilities: {
              mode: "none",
              wire: "none",
              supportsDisabled: true,
            },
          },
        ],
      },
    },
    attempts,
    providerCalls: () => providerCalls,
  };
}

function unavailable(headers?: Record<string, string>): Response {
  return Response.json(
    { error: { message: "controlled unavailable", type: "server_error" } },
    { status: 503, headers },
  );
}

function chunk(
  delta: Record<string, unknown>,
  finish: string | null = null,
): unknown {
  return {
    id: "chat_fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "fixture",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function sse(events: readonly unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

function success(protocol: (typeof protocols)[number]): Response {
  if (protocol === "openai-compatible") {
    return sse([chunk({ content: "done" }, "stop")]);
  }
  if (protocol === "anthropic") {
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: "fixture",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "done" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ];
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
  }
  const part = {
    type: "output_text",
    text: "done",
    annotations: [],
    logprobs: [],
  };
  const item = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [part],
  };
  const ref = { item_id: "msg_fixture", output_index: 0, content_index: 0 };
  return sse([
    {
      type: "response.output_item.added",
      ...ref,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      ...ref,
      part: { ...part, text: "" },
    },
    { type: "response.output_text.delta", ...ref, delta: "done", logprobs: [] },
    { type: "response.output_text.done", ...ref, text: "done", logprobs: [] },
    { type: "response.content_part.done", ...ref, part },
    { type: "response.output_item.done", ...ref, item },
    {
      type: "response.completed",
      response: {
        id: "resp_fixture",
        status: "completed",
        output: [item],
        usage: { input_tokens: 12, output_tokens: 1, total_tokens: 13 },
        previous_response_id: null,
        store: false,
      },
    },
  ]);
}

function consume(
  client: LLMClientInstance,
  options: {
    signal?: AbortSignal;
    onFrame?: (frame: StreamingResponse) => void;
    maxRetriesPerStep?: number;
  } = {},
): {
  frames: StreamingResponse[];
  done: Promise<{ error?: unknown }>;
} {
  const frames: StreamingResponse[] = [];
  const done = (async (): Promise<{ error?: unknown }> => {
    try {
      for await (const frame of streamResponse(
        client,
        [{ role: "user", content: "fixture" }],
        {
          signal: options.signal,
          ...(options.maxRetriesPerStep === undefined
            ? {}
            : { retry: { maxRetriesPerStep: options.maxRetriesPerStep } }),
        },
      )) {
        frames.push(frame);
        options.onFrame?.(frame);
      }
      return {};
    } catch (error) {
      return { error };
    }
  })();
  return { frames, done };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("installed SDK and project retry boundaries", () => {
  describe.each(protocols)("%s HTTP request ownership", (protocol) => {
    it("sends exactly one HTTP request on success", async () => {
      const f = fixture(() => success(protocol), protocol);
      const run = consume(f.client);
      await vi.runAllTimersAsync();
      expect(await run.done).toEqual({});
      expect(f.attempts.map((attempt) => attempt.providerCall)).toEqual([1]);
      expect(run.frames.at(-1)?.messageSnapshot.content).toBe("done");
    });

    it("uses one application retry for a transient failure followed by success", async () => {
      const f = fixture(
        (attempt) => (attempt === 1 ? unavailable() : success(protocol)),
        protocol,
      );
      const run = consume(f.client, { maxRetriesPerStep: 1 });
      await vi.runAllTimersAsync();
      expect(await run.done).toEqual({});
      expect(f.attempts.map((attempt) => attempt.providerCall)).toEqual([1, 2]);
      expect(run.frames.filter((frame) => frame.retry)).toHaveLength(1);
      expect(run.frames.at(-1)?.messageSnapshot.content).toBe("done");
    });

    it("sends no more than two HTTP requests with one application retry", async () => {
      const f = fixture(() => unavailable(), protocol);
      const run = consume(f.client, { maxRetriesPerStep: 1 });
      await vi.runAllTimersAsync();
      expect((await run.done).error).toMatchObject({
        attempts: 1,
        cause: { status: 503 },
      });
      expect(f.attempts.map((attempt) => attempt.providerCall)).toEqual([1, 2]);
    });

    it("does not spend application retries on context overflow even with a 503 status", async () => {
      const f = fixture(
        () =>
          Response.json(
            {
              error: {
                message: "maximum context length exceeded",
                type: "context_length_exceeded",
                code: "context_length_exceeded",
              },
            },
            { status: 503 },
          ),
        protocol,
      );
      const run = consume(f.client);
      await vi.runAllTimersAsync();
      expect((await run.done).error).toMatchObject({ status: 503 });
      expect(f.attempts.map((attempt) => attempt.providerCall)).toEqual([1]);
      expect(run.frames.filter((frame) => frame.retry)).toHaveLength(0);
    });
  });

  it.each(protocols)(
    "%s bounds repeated 503s at six HTTP attempts and five application retry events",
    async (protocol) => {
      const f = fixture(() => unavailable(), protocol);
      const run = consume(f.client);
      await vi.runAllTimersAsync();
      const { error } = await run.done;
      expect(error).toBeInstanceOf(ProviderRetryExhaustedError);
      expect(error).toMatchObject({ attempts: 5, cause: { status: 503 } });
      expect(f.providerCalls()).toBe(6);
      expect(f.attempts.map((attempt) => attempt.providerCall)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      expect(run.frames.map((frame) => frame.retry?.attempt)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(run.frames.every((frame) => frame.retry?.maxRetries === 5)).toBe(
        true,
      );
    },
  );

  it("retries each failed HTTP request in the application before the fourth succeeds", async () => {
    const f = fixture((attempt) =>
      attempt <= 3 ? unavailable() : sse([chunk({ content: "done" }, "stop")]),
    );
    const run = consume(f.client);
    await vi.runAllTimersAsync();
    expect(await run.done).toEqual({});
    expect(f.providerCalls()).toBe(4);
    expect(f.attempts.map((attempt) => attempt.providerCall)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(run.frames.filter((frame) => frame.retry)).toHaveLength(3);
    expect(run.frames.at(-1)).toMatchObject({
      finishReason: "stop",
      messageSnapshot: { content: "done" },
    });
  });

  it.each([
    {
      code: "ECONNRESET",
      message: "socket closed",
      type: OpenAI.APIConnectionError,
    },
    {
      code: "ETIMEDOUT",
      message: "connection timed out",
      type: OpenAI.APIConnectionTimeoutError,
    },
  ])(
    "preserves the outer classification after the SDK wraps $code",
    async ({ code, message, type }) => {
      const transport = Object.assign(new Error(message), { code });
      expect(isRetryableProviderError(transport)).toBe(true);
      const f = fixture(() => Promise.reject(transport));
      const run = consume(f.client);
      await vi.runAllTimersAsync();
      const { error } = await run.done;
      expect(error).toBeInstanceOf(type);
      expect(isRetryableProviderError(error)).toBe(false);
      expect(f.attempts).toHaveLength(1);
      expect(f.providerCalls()).toBe(1);
      expect(run.frames.filter((frame) => frame.retry)).toHaveLength(0);
    },
  );

  it.each([
    { label: "text", delta: { content: "partial" } },
    { label: "reasoning", delta: { reasoning_content: "partial thought" } },
    {
      label: "tool arguments",
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: '{"path":' },
          },
        ],
      },
    },
  ])(
    "does not retry after partial $label even when the later SSE error is retryable",
    async ({ delta }) => {
      const f = fixture(() =>
        sse([
          chunk(delta),
          {
            error: { message: "controlled stream failure", code: "ECONNRESET" },
          },
        ]),
      );
      const run = consume(f.client);
      await vi.runAllTimersAsync();
      const { error } = await run.done;
      expect(error).toBeInstanceOf(ProviderStreamInterruptedError);
      expect(
        isRetryableProviderError(
          (error as ProviderStreamInterruptedError).cause,
        ),
      ).toBe(true);
      expect(f.attempts).toHaveLength(1);
      expect(f.providerCalls()).toBe(1);
      expect(run.frames.length).toBeGreaterThan(0);
      expect(run.frames.filter((frame) => frame.retry)).toHaveLength(0);
    },
  );

  it.each(protocols)(
    "%s cancels promptly during application Retry-After and sends no later HTTP request",
    async (protocol) => {
      const f = fixture(() => unavailable({ "retry-after": "2" }), protocol);
      const controller = new AbortController();
      const run = consume(f.client, { signal: controller.signal });
      let settled = false;
      void run.done.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(f.attempts).toHaveLength(1);
      controller.abort();
      const cancelledAt = Date.now();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(await run.done).toEqual({});
      expect(Date.now() - cancelledAt).toBe(0);
      // The application backoff must not send another request after cancellation.
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.attempts).toHaveLength(1);
      expect(f.providerCalls()).toBe(1);
      expect(run.frames.filter((frame) => frame.retry)).toHaveLength(1);
      expect(run.frames.at(-1)?.streamStopReason).toBe("user_aborted");
    },
  );

  it("cancels project Retry-After backoff promptly after a single HTTP attempt", async () => {
    const f = fixture(() => unavailable({ "retry-after-ms": "2000" }));
    const controller = new AbortController();
    let outerRetryAt: number | undefined;
    const run = consume(f.client, {
      signal: controller.signal,
      onFrame: (frame) => {
        if (frame.retry) {
          outerRetryAt = Date.now();
          setTimeout(() => {
            controller.abort();
          }, 100);
        }
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(outerRetryAt).toBe(0);
    expect(run.frames.find((frame) => frame.retry)?.retry?.delayMs).toBe(2000);
    await vi.advanceTimersByTimeAsync(100);
    expect(await run.done).toEqual({});
    expect(Date.now() - (outerRetryAt ?? 0)).toBe(100);
    expect(run.frames.at(-1)?.streamStopReason).toBe("user_aborted");
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.attempts).toHaveLength(1);
    expect(f.providerCalls()).toBe(1);
  });
});

describe.each(protocols)("%s Context summary HTTP budget", (protocol) => {
  it.each([
    { failures: 0, fault: "503", attempts: 1, status: "compacted" },
    { failures: 1, fault: "503", attempts: 2, status: "compacted" },
    { failures: 2, fault: "503", attempts: 2, status: "failed" },
    { failures: 1, fault: "ECONNRESET", attempts: 2, status: "compacted" },
  ] as const)(
    "limits $failures initial $fault failures to $attempts actual HTTP requests",
    async ({ failures, fault, attempts, status }) => {
      const f = fixture((attempt) => {
        if (attempt > failures) return success(protocol);
        if (fault === "ECONNRESET") {
          throw Object.assign(new Error("socket reset before first byte"), {
            code: "ECONNRESET",
          });
        }
        return unavailable();
      }, protocol);
      const bus = createBus();
      const messageManager = createMessageManager({
        bus,
        store: createInMemoryMessageStore(),
      });
      for (let index = 0; index < 8; index++) {
        const message = await messageManager.createMessage({
          sessionId: "summary-budget",
          agent: "build",
          role: index % 2 === 0 ? "user" : "assistant",
        });
        await messageManager.appendPart(message.id, {
          type: "text",
          text: `${String(index)}: ${"Old long history. ".repeat(450)}`,
        });
      }
      const manager = createContextManager({
        bus,
        messageManager,
        llmClient: createContextSummaryClient(f.client),
        systemPromptProvider: { build: () => Promise.resolve("Stable system") },
        tokenCounter: {
          estimateTokens: (text) => text.length,
          getLimit: () => 128000,
        },
      });
      const compact = manager.compact("summary-budget", {
        directory: "/repo",
        force: true,
        modelId: "fixture",
        toolNames: [],
        tools: undefined,
        requestSettings: resolvePreparedRequestSettings(f.client),
      });
      await vi.runAllTimersAsync();
      const result = await compact;
      expect(result.status).toBe(status);
      expect(f.attempts).toHaveLength(attempts);
      expect(f.attempts.map((attempt) => attempt.providerCall)).toEqual(
        attempts === 1 ? [1] : [1, 2],
      );
      if (status === "compacted") {
        expect(result.compression?.requests).toHaveLength(attempts);
        expect(
          result.compression?.requests?.map((request) => request.attempt),
        ).toEqual(attempts === 1 ? [1] : [1, 2]);
      }
    },
  );
});

describe.each(protocols)("%s SDK idle watchdog", (protocol) => {
  it("counts raw activity even when the adapter emits no normalized event", async () => {
    const bytes = new TextEncoder();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const f = fixture(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              body = controller;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      protocol,
    );
    const source = await success(protocol).text();
    const frames = source.split("\n\n").filter(Boolean);
    const output: StreamingResponse[] = [];
    const caller = new AbortController();
    const done = (async (): Promise<unknown> => {
      try {
        for await (const frame of streamResponse(
          f.client,
          [{ role: "user", content: "test" }],
          {
            idleTimeoutMs: 100,
            signal: caller.signal,
            retry: { maxRetriesPerStep: 0 },
          },
        ))
          output.push(frame);
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    await vi.advanceTimersByTimeAsync(0);
    // Two real SDK events, 80 ms apart, neither authorizes any output.
    const silent =
      protocol === "openai-compatible"
        ? [1, 2].map(
            () => `data: ${JSON.stringify(chunk({ role: "assistant" }))}`,
          )
        : protocol === "openai-responses"
          ? ["response.created", "response.in_progress"].map(
              (type) =>
                `data: ${JSON.stringify({
                  type,
                  response: {
                    id: "resp_fixture",
                    status: "in_progress",
                    output: [],
                    previous_response_id: null,
                    store: false,
                  },
                })}`,
            )
          : frames.splice(0, 2); // message_start and empty text block start
    try {
      for (const event of silent) {
        await vi.advanceTimersByTimeAsync(80);
        body.enqueue(bytes.encode(`${event}\n\n`));
        await vi.advanceTimersByTimeAsync(0);
        expect(output).toEqual([]);
      }
      await vi.advanceTimersByTimeAsync(80);
      body.enqueue(bytes.encode(frames.join("\n\n") + "\n\n"));
      body.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(await done).toBeUndefined();
      expect(output.at(-1)?.messageSnapshot.content).toBe("done");
      expect(f.attempts).toHaveLength(1);
    } finally {
      caller.abort();
      await done;
    }
  });

  it("uses only application retries for stalled HTTP bodies", async () => {
    const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
    const f = fixture(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              bodies.push(controller);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      protocol,
    );
    const done = (async (): Promise<unknown> => {
      try {
        for await (const _ of streamResponse(
          f.client,
          [{ role: "user", content: "test" }],
          {
            idleTimeoutMs: 100,
            retry: { maxRetriesPerStep: 2, initialDelayMs: 0 },
          },
        )) {
          /* drain retry notifications */
        }
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    await vi.advanceTimersByTimeAsync(300);
    expect(await done).toBeInstanceOf(ProviderRetryExhaustedError);
    expect(f.attempts.map((a) => a.providerCall)).toEqual([1, 2, 3]);
    // Settle detached SDK reads without adding a second cleanup wait to production.
    for (const body of bodies) {
      try {
        body.close();
      } catch {
        /* abort may already cancel the body */
      }
    }
    await vi.advanceTimersByTimeAsync(0);
  });
});
