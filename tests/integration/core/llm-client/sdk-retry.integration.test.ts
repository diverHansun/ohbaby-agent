import { createServer } from "node:http";
import type { Socket } from "node:net";
import { createTestContextManager as createContextManager } from "../../../fixtures/model-fixtures.js";
import OpenAI from "openai";
import { createBus } from "../../../../packages/ohbaby-agent/src/bus/index.js";
import { createContextSummaryClient } from "../../../../packages/ohbaby-agent/src/adapters/ui-runtime/prompt-context.js";

import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../../../packages/ohbaby-agent/src/core/message/index.js";
import { createAnthropicProvider } from "ohbaby-llm";
import { createOpenAIResponsesProvider } from "ohbaby-llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleProvider } from "ohbaby-llm";
import {
  isRetryableProviderError,
  isContextOverflowError,
  providerErrorDetail,
  ProviderRetryExhaustedError,
  ProviderStreamInterruptedError,
} from "ohbaby-llm";
import { resolvePreparedRequestSettings, streamResponse } from "ohbaby-llm";
import type {
  InterfaceProviderStreamEvent,
  LLMClientInstance,
  StreamingResponse,
} from "ohbaby-llm";

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
    purpose?: NonNullable<Parameters<typeof streamResponse>[2]>["purpose"];
    priorFailedAttempts?: number;
    onRequestObservation?: NonNullable<
      Parameters<typeof streamResponse>[2]
    >["onRequestObservation"];
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
          purpose: options.purpose,
          priorFailedAttempts: options.priorFailedAttempts,
          onRequestObservation: options.onRequestObservation,
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

function earlyEof(protocol: (typeof protocols)[number]): Response {
  return new Response(protocol === "anthropic" ? "" : "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

function anthropicSse(events: readonly { type: string }[]): Response {
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function streamFailure(protocol: (typeof protocols)[number]): Response {
  if (protocol === "anthropic") {
    const event = {
      type: "error",
      error: { type: "overloaded_error", message: "controlled overload" },
    };
    return anthropicSse([event]);
  }
  return sse([
    { error: { code: "server_error", message: "controlled failure" } },
  ]);
}

describe.each(protocols)("%s agent-step stream errors", (protocol) => {
  it.each([
    {
      fault: "in-stream error",
      response: streamFailure,
      reason: protocol === "anthropic" ? "overloaded_error" : "server_error",
    },
    {
      fault: "missing terminal event",
      response: earlyEof,
      reason: "stream_eof",
    },
  ])("retries $fault before any output", async ({ response, reason }) => {
    const f = fixture(
      (attempt) => (attempt === 1 ? response(protocol) : success(protocol)),
      protocol,
    );
    const run = consume(f.client, { purpose: "agent-step" });
    await vi.runAllTimersAsync();
    expect(await run.done).toEqual({});
    expect(f.attempts).toHaveLength(2);
    expect(run.frames.flatMap((frame) => frame.retry?.reason ?? [])).toEqual([
      reason,
    ]);
    expect(run.frames.at(-1)?.messageSnapshot.content).toBe("done");
  });
});

it.each(["agent-step", "context-summary"] as const)(
  "requires Anthropic message_stop even after receiving stop_reason for %s",
  async (purpose) => {
    const start = {
      type: "message_start",
      message: {
        id: "msg_empty",
        type: "message",
        role: "assistant",
        model: "fixture",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    };
    const delta = {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    };
    const f = fixture(
      (attempt) =>
        attempt === 1 ? anthropicSse([start, delta]) : success("anthropic"),
      "anthropic",
    );
    const run = consume(f.client, { purpose });
    await vi.runAllTimersAsync();
    if (purpose === "context-summary") {
      expect((await run.done).error).toMatchObject({ source: "eof" });
      expect(f.attempts).toHaveLength(1);
      expect(run.frames.some((frame) => frame.retry)).toBe(false);
      return;
    }
    expect(await run.done).toEqual({});
    expect(f.attempts).toHaveLength(2);
    expect(run.frames.find((frame) => frame.retry)?.retry?.reason).toBe(
      "stream_eof",
    );
    expect(run.frames.at(-1)?.messageSnapshot.content).toBe("done");
  },
);

it.each([
  { networkCode: "UND_ERR_SOCKET", attempts: 2 },
  { networkCode: "CERT_HAS_EXPIRED", attempts: 1 },
])(
  "uses explicit network evidence in nested SDK causes ($networkCode)",
  async ({ networkCode, attempts }) => {
    const f = fixture((attempt) => {
      if (attempt > 1) return success("openai-compatible");
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("underlying network fault"), {
          code: networkCode,
        }),
      });
    });
    const run = consume(f.client, { purpose: "agent-step" });
    await vi.runAllTimersAsync();
    const { error } = await run.done;
    expect(f.attempts).toHaveLength(attempts);
    if (attempts === 2) {
      expect(error).toBeUndefined();
      expect(run.frames.find((frame) => frame.retry)?.retry?.reason).toBe(
        "und_err_socket",
      );
    } else {
      expect(providerErrorDetail(error)).toMatchObject({
        kind: "tls",
        networkCode,
      });
      expect(run.frames.some((frame) => frame.retry)).toBe(false);
    }
  },
);

it.each([
  {
    protocol: "openai-compatible",
    response: () =>
      sse([{ error: { type: "invalid_request_error", message: "fixture" } }]),
    kind: "invalid_request",
  },
  {
    protocol: "anthropic",
    response: () => {
      const event = {
        type: "error",
        error: { type: "invalid_request_error", message: "fixture" },
      };
      return anthropicSse([event]);
    },
    kind: "invalid_request",
  },
  {
    protocol: "openai-compatible",
    response: () =>
      sse([{ error: { code: "unknown_error_fixture", message: "fixture" } }]),
    kind: "unknown",
  },
  {
    protocol: "openai-compatible",
    response: () =>
      Response.json(
        {
          error: {
            code: "insufficient_quota",
            type: "rate_limit_error",
            message: "fixture",
          },
        },
        { status: 429 },
      ),
    kind: "billing",
  },
] as const)(
  "keeps $protocol $kind failures terminal",
  async ({ protocol, response, kind }) => {
    const f = fixture(response, protocol);
    const run = consume(f.client, { purpose: "agent-step" });
    await vi.runAllTimersAsync();
    expect(f.attempts).toHaveLength(1);
    expect(run.frames.some((frame) => frame.retry)).toBe(false);
    expect(providerErrorDetail((await run.done).error)?.kind).toBe(kind);
  },
);

describe("Responses explicit failure events", () => {
  it.each([
    { code: "server_error", attempts: 2, kind: undefined },
    { code: "invalid_prompt", attempts: 1, kind: "invalid_request" },
    { code: "context_length_exceeded", attempts: 1, kind: "context_overflow" },
    { code: "unrecognized_fixture_error", attempts: 1, kind: "unknown" },
    { code: null, attempts: 1, kind: "unknown" },
  ])("handles response.failed with $code", async ({ code, attempts, kind }) => {
    const f = fixture(
      (attempt) =>
        attempt === 1
          ? sse([
              {
                type: "response.failed",
                response: {
                  id: "resp_failed",
                  status: "failed",
                  error: code
                    ? { code, message: "upstream detail must not be exposed" }
                    : null,
                },
              },
            ])
          : success("openai-responses"),
      "openai-responses",
    );
    const run = consume(f.client, { purpose: "agent-step" });
    await vi.runAllTimersAsync();
    const { error } = await run.done;
    expect(f.attempts).toHaveLength(attempts);
    if (kind === undefined) {
      expect(error).toBeUndefined();
      expect(run.frames.find((frame) => frame.retry)?.retry?.reason).toBe(code);
    } else {
      const detail = providerErrorDetail(error);
      expect(detail?.kind).toBe(kind);
      expect(detail?.upstreamCode).toBe(kind === "unknown" ? undefined : code);
      expect(detail?.message).not.toContain("upstream detail");
      expect(isContextOverflowError(error)).toBe(kind === "context_overflow");
    }
  });
});

describe("agent-step retry after partial output", () => {
  it("seals the failed request and signals retry before throwing a real socket interruption", async () => {
    vi.useRealTimers();
    const realFetch = globalThis.fetch;
    let socket: Socket | undefined;
    const server = createServer((request, response) => {
      socket = request.socket;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify(chunk({ content: "partial" }))}\n\n`,
      );
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected TCP listener");
      const f = fixture(() =>
        realFetch(`http://127.0.0.1:${String(address.port)}`),
      );
      const order: string[] = [];
      let observedRetryDelayMs: number | undefined;
      const run = consume(f.client, {
        purpose: "agent-step",
        priorFailedAttempts: 0,
        onRequestObservation: (fact) => {
          if (fact.type === "request-ended") {
            order.push("request-ended");
            expect(fact.request).toMatchObject({
              attempt: 1,
              outcome: "error",
              retryScheduled: true,
            });
            expect(fact.failure).toMatchObject({
              networkCode: "UND_ERR_SOCKET",
            });
            observedRetryDelayMs = fact.failure?.retryDelayMs;
          }
          return Promise.resolve();
        },
        onFrame: (frame) => {
          if (frame.messageSnapshot.content === "partial") socket?.destroy();
          if (frame.retry) order.push("retry");
        },
      });
      const { error } = await run.done;
      const retry = run.frames.find((frame) => frame.retry)?.retry;
      expect(retry).toMatchObject({ attempt: 1, reason: "und_err_socket" });
      expect(observedRetryDelayMs).toBeTypeOf("number");
      expect(observedRetryDelayMs).toBe(retry?.delayMs);
      expect(error).toMatchObject({
        name: "ProviderStreamInterruptedError",
        source: "transport",
        stepRetry: { delayMs: retry?.delayMs },
      });
      expect(order).toEqual(["request-ended", "retry"]);
      expect(f.attempts).toHaveLength(1);
    } finally {
      socket?.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it.each([2, 5])(
    "counts prior failures (%s) against the same budget",
    async (priorFailedAttempts) => {
      const f = fixture(() =>
        sse([chunk({ reasoning_content: "partial thought" })]),
      );
      const attempts: number[] = [];
      const run = consume(f.client, {
        purpose: "agent-step",
        priorFailedAttempts,
        onRequestObservation: (fact) => {
          if (fact.type === "request-ended")
            attempts.push(fact.request.attempt);
          return Promise.resolve();
        },
      });
      await vi.runAllTimersAsync();
      const { error } = await run.done;
      expect(attempts).toEqual([priorFailedAttempts + 1]);
      expect(f.attempts).toHaveLength(1);
      const retry = run.frames.find((frame) => frame.retry)?.retry;
      if (priorFailedAttempts === 2) {
        expect(retry).toMatchObject({ attempt: 3, reason: "stream_eof" });
        expect(error).toMatchObject({
          source: "eof",
          stepRetry: { delayMs: retry?.delayMs },
        });
        expect(providerErrorDetail(error)?.upstreamReason).toBe("stream_eof");
      } else {
        expect(retry).toBeUndefined();
        expect(error).toBeInstanceOf(ProviderRetryExhaustedError);
        expect(error).toMatchObject({ attempts: 5, cause: { source: "eof" } });
      }
    },
  );

  it.each([
    { fault: new OpenAI.APIUserAbortError(), source: "provider_abort" },
    {
      fault: Object.assign(new Error("unknown provider exception"), {
        code: "fixture_unknown",
      }),
      source: undefined,
    },
    {
      fault: Object.assign(new Error("untyped exception"), {
        code: "server_error",
        type: "overloaded_error",
      }),
      source: undefined,
    },
  ])(
    "does not retry partial output for $fault.message",
    async ({ fault, source }) => {
      const f = fixture(() => success("openai-compatible"));
      async function* partial(): AsyncGenerator<InterfaceProviderStreamEvent> {
        yield await Promise.resolve({ textDelta: "partial" });
        throw fault;
      }
      vi.spyOn(f.client.provider, "streamResponse").mockImplementation(() =>
        Promise.resolve(partial()),
      );
      const run = consume(f.client, {
        purpose: "agent-step",
        priorFailedAttempts: 0,
      });
      await vi.runAllTimersAsync();
      const { error } = await run.done;
      expect(error).toMatchObject({
        name: "ProviderStreamInterruptedError",
        source,
      });
      expect(error).not.toHaveProperty("stepRetry", expect.anything());
      expect(run.frames.some((frame) => frame.retry)).toBe(false);
    },
  );

  it("does not retry malformed tool arguments after a successful stream", async () => {
    const f = fixture(() =>
      sse([
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "test", arguments: "{" },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ]),
    );
    const run = consume(f.client, {
      purpose: "agent-step",
      priorFailedAttempts: 0,
    });
    await vi.runAllTimersAsync();
    expect((await run.done).error).toMatchObject({
      name: "ToolCallParseError",
    });
    expect(run.frames.some((frame) => frame.retry)).toBe(false);
    expect(f.attempts).toHaveLength(1);
  });

  it("does not schedule a retry after local cancellation of a partial stream", async () => {
    const f = fixture(() => sse([chunk({ content: "partial" })]));
    const controller = new AbortController();
    const run = consume(f.client, {
      purpose: "agent-step",
      priorFailedAttempts: 0,
      signal: controller.signal,
      onFrame: (frame) => {
        if (frame.messageSnapshot.content === "partial") controller.abort();
      },
    });
    await vi.runAllTimersAsync();
    expect(await run.done).toEqual({});
    expect(run.frames.at(-1)?.streamStopReason).toBe("user_aborted");
    expect(run.frames.some((frame) => frame.retry)).toBe(false);
    expect(f.attempts).toHaveLength(1);
  });

  it("does not schedule a retry when a later event violates the Responses protocol", async () => {
    const f = fixture(
      () =>
        sse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "msg_partial",
              type: "message",
              role: "assistant",
              status: "in_progress",
              content: [],
            },
          },
          {
            type: "response.content_part.added",
            item_id: "msg_partial",
            output_index: 0,
            content_index: 0,
            part: {
              type: "output_text",
              text: "",
              annotations: [],
              logprobs: [],
            },
          },
          {
            type: "response.output_text.delta",
            item_id: "msg_partial",
            output_index: 0,
            content_index: 0,
            delta: "partial",
          },
          { type: "response.unknown" },
        ]),
      "openai-responses",
    );
    const run = consume(f.client, {
      purpose: "agent-step",
      priorFailedAttempts: 0,
    });
    await vi.runAllTimersAsync();
    expect(
      run.frames.some((frame) => frame.messageSnapshot.content === "partial"),
    ).toBe(true);
    expect((await run.done).error).toBeInstanceOf(
      ProviderStreamInterruptedError,
    );
    expect((await run.done).error).not.toHaveProperty(
      "stepRetry",
      expect.anything(),
    );
    expect(run.frames.some((frame) => frame.retry)).toBe(false);
    expect(f.attempts).toHaveLength(1);
  });

  it.each(["agent-step", "context-summary", "session-title"] as const)(
    "preserves the %s caller's opt-in boundary for post-output retry",
    async (purpose) => {
      const f = fixture(() => sse([chunk({ content: "partial" })]));
      const run = consume(f.client, { purpose });
      await vi.runAllTimersAsync();
      expect((await run.done).error).toMatchObject({ source: "eof" });
      expect((await run.done).error).not.toHaveProperty(
        "stepRetry",
        expect.anything(),
      );
      expect(run.frames.some((frame) => frame.retry)).toBe(false);
      expect(f.attempts).toHaveLength(1);
    },
  );
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
    "retries in the application after the SDK wraps $code",
    async ({ code, message, type }) => {
      const transport = Object.assign(new Error(message), { code });
      const wrapped = fixture(() => Promise.reject(transport));
      const failing = consume(wrapped.client);
      await vi.runAllTimersAsync();
      const { error } = await failing.done;
      // The SDK hides the code; retries must still recognize the wrapper.
      expect((error as { cause?: unknown }).cause).toBeInstanceOf(type);
      expect(wrapped.providerCalls()).toBe(6);

      const f = fixture((attempt) =>
        attempt === 1
          ? Promise.reject(transport)
          : sse([chunk({ content: "done" }, "stop")]),
      );
      const run = consume(f.client);
      await vi.runAllTimersAsync();
      expect(await run.done).toEqual({});
      expect(f.providerCalls()).toBe(2);
      expect(run.frames.filter((frame) => frame.retry)).toHaveLength(1);
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
    { failures: 1, fault: "in-stream error", attempts: 1, status: "failed" },
    { failures: 1, fault: "EOF", attempts: 1, status: "failed" },
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
        if (fault === "in-stream error") return streamFailure(protocol);
        if (fault === "EOF") return earlyEof(protocol);
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
