import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installFormalCacheObserver,
  auditFormalNativeReplay,
  auditFormalToolExchange,
  type FormalCacheGenerationEvidence,
} from "./formal-cache-observer.js";

const url = "https://zenmux.ai/api/v1/chat/completions";
const originalFetch = globalThis.fetch;
function generations(
  observer: ReturnType<typeof installFormalCacheObserver>,
): FormalCacheGenerationEvidence[] {
  return observer.records.filter(
    (item): item is FormalCacheGenerationEvidence => item.kind === "generation",
  );
}
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function stream(frames: unknown[]): { wire: string; response: Response } {
  const wire =
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return {
    wire,
    response: new Response(
      new ReadableStream({
        start(controller): void {
          // Break frames across arbitrary chunks to exercise observation of real streams.
          const bytes = new TextEncoder().encode(wire);
          controller.enqueue(bytes.slice(0, 17));
          controller.enqueue(bytes.slice(17));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  };
}

describe("formal backend passive cache observer", () => {
  it("native replay requires actual expected hashes and distinguishes an unexercised branch", () => {
    expect(auditFormalNativeReplay(["one"], [])).toMatchObject({
      exercised: true,
      valid: false,
    });
    expect(auditFormalNativeReplay(["one"], undefined).valid).toBe(false);
    expect(auditFormalNativeReplay(["one"], ["other"]).valid).toBe(false);
    expect(
      auditFormalNativeReplay(["two", "one"], ["one", "two"]),
    ).toMatchObject({ exercised: true, valid: true });
    expect(auditFormalNativeReplay([], [])).toMatchObject({
      exercised: false,
      valid: true,
    });
  });
  it.each([
    {
      path: "/api/v1/responses",
      body: {
        input: [
          { type: "function_call", call_id: "private-a" },
          { type: "function_call", call_id: "private-b" },
          { type: "function_call_output", call_id: "private-b" },
          { type: "function_call_output", call_id: "private-a" },
        ],
      },
    },
    {
      path: "/api/v1/chat/completions",
      body: {
        messages: [
          { role: "assistant", tool_calls: [{ id: "private-a" }] },
          { role: "tool", tool_call_id: "private-a" },
        ],
      },
    },
    {
      path: "/api/anthropic/v1/messages",
      body: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "private-a" }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "private-a" }],
          },
        ],
      },
    },
  ])(
    "requires a nonempty exchange and validates $path pairing without fixing parallel-result order",
    async ({ path, body }) => {
      globalThis.fetch = vi
        .fn<typeof fetch>()
        .mockImplementation(() => Promise.resolve(new Response("{}")));
      const observer = installFormalCacheObserver();
      expect(auditFormalToolExchange([])).toMatchObject({
        exercised: false,
        valid: false,
      });
      await fetch(`https://zenmux.ai${path}`, { method: "POST", body: "{}" });
      await observer.drain();
      expect(auditFormalToolExchange(generations(observer)).valid).toBe(false);
      await fetch(`https://zenmux.ai${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      await observer.drain();
      expect(auditFormalToolExchange(generations(observer))).toMatchObject({
        exercised: true,
        valid: true,
        pairedRequestSequences: [2],
      });
      expect(JSON.stringify(observer.records)).not.toContain("private-");
      observer.restore();
    },
  );
  it.each([
    {
      label: "empty ID",
      items: [
        { type: "function_call", call_id: "" },
        { type: "function_call_output", call_id: "" },
      ],
      key: "invalidIds",
    },
    {
      label: "missing ID",
      items: [{ type: "function_call" }, { type: "function_call_output" }],
      key: "invalidIds",
    },
    {
      label: "duplicate call",
      items: [
        { type: "function_call", call_id: "private-id" },
        { type: "function_call", call_id: "private-id" },
        { type: "function_call_output", call_id: "private-id" },
      ],
      key: "duplicateCalls",
    },
    {
      label: "duplicate result",
      items: [
        { type: "function_call", call_id: "private-id" },
        { type: "function_call_output", call_id: "private-id" },
        { type: "function_call_output", call_id: "private-id" },
      ],
      key: "duplicateResults",
    },
    {
      label: "result before call",
      items: [
        { type: "function_call_output", call_id: "private-id" },
        { type: "function_call", call_id: "private-id" },
      ],
      key: "resultsBeforeCalls",
    },
  ])("safely flags $label in wire tool pairing", async ({ items, key }) => {
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}"));
    const observer = installFormalCacheObserver();
    await fetch("https://zenmux.ai/api/v1/responses", {
      method: "POST",
      body: JSON.stringify({ input: items }),
    });
    await observer.drain();
    const audit = generations(observer)[0].toolPairing as unknown as Record<
      string,
      unknown
    >;
    expect(audit[key]).toBeGreaterThan(0);
    expect(auditFormalToolExchange(generations(observer)).valid).toBe(false);
    expect(JSON.stringify(observer.records)).not.toContain("private-id");
    observer.restore();
  });
  it.each(["/api/v1/models", "/api/anthropic/v1/models"])(
    "passes metadata GET %s unchanged with only bounded request metadata",
    async (path) => {
      const body = JSON.stringify({
        data: [{ id: "private model metadata", key: "private key" }],
      });
      const response = new Response(body, { status: 200 });
      const fake = vi.fn<typeof fetch>().mockResolvedValue(response);
      globalThis.fetch = fake;
      const observer = installFormalCacheObserver({
        maxRequests: 1,
        context: () => ({ purpose: "reload", id: 4 }),
      });
      const endpoint = `https://zenmux.ai${path}`;
      const init = {
        method: "GET",
        headers: { Authorization: "private authorization" },
      };
      expect(await fetch(endpoint, init)).toBe(response);
      await observer.drain();
      expect(fake).toHaveBeenCalledWith(endpoint, init);
      expect(observer.records).toEqual([
        {
          kind: "metadata",
          sequence: 1,
          path,
          status: 200,
          context: { purpose: "reload", id: 4 },
        },
      ]);
      expect(response.bodyUsed).toBe(false);
      expect(await response.text()).toBe(body);
      expect(JSON.stringify(observer.records)).not.toContain("private");
      await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow(
        "REQUEST_LIMIT",
      );
      expect(fake).toHaveBeenCalledTimes(1);
      observer.restore();
    },
  );

  it("rejects metadata POST requests and metadata requests to other hosts", async () => {
    const fake = vi.fn<typeof fetch>();
    globalThis.fetch = fake;
    const observer = installFormalCacheObserver();
    await expect(
      fetch("https://zenmux.ai/api/v1/models", { method: "POST" }),
    ).rejects.toThrow("NETWORK_DENIED");
    await expect(fetch("https://example.com/api/v1/models")).rejects.toThrow(
      "NETWORK_DENIED",
    );
    expect(fake).not.toHaveBeenCalled();
    observer.restore();
  });

  it("returns the exact original response and forwards original request arguments", async () => {
    const { response, wire } = stream([
      {
        choices: [{ delta: { content: "private response" } }],
        usage: {
          prompt_tokens: 10,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      },
    ]);
    const fake = vi.fn<typeof fetch>().mockResolvedValue(response);
    globalThis.fetch = fake;
    const observer = installFormalCacheObserver({
      context: () => ({ purpose: "turn", id: 3 }),
    });
    const init = {
      method: "POST",
      body: JSON.stringify({
        model: "openai/gpt-5",
        messages: [{ role: "user", content: "private request" }],
      }),
      headers: { Authorization: "secret key" },
    };
    const returned = await fetch(url, init);
    expect(returned).toBe(response);
    expect(fake).toHaveBeenCalledWith(url, init);
    expect(await returned.text()).toBe(wire);
    await observer.drain();
    expect(generations(observer)[0]).toMatchObject({
      context: { purpose: "turn", id: 3 },
      status: 200,
      finalUsage: { prompt_tokens_details: { cached_tokens: 0 } },
    });
    const json = JSON.stringify(observer.records);
    for (const secret of [
      "private response",
      "private request",
      "secret key",
      "Authorization",
    ])
      expect(json).not.toContain(secret);
    observer.restore();
    expect(globalThis.fetch).toBe(fake);
  });

  it.each([
    {
      path: "/api/v1/chat/completions",
      frames: [{ usage: { prompt_tokens: 40 } }],
      expected: { prompt_tokens: 40 },
    },
    {
      path: "/api/v1/responses",
      frames: [
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 40,
              input_tokens_details: { cached_tokens: 32 },
            },
          },
        },
      ],
      expected: {
        input_tokens: 40,
        input_tokens_details: { cached_tokens: 32 },
      },
    },
    {
      path: "/api/anthropic/v1/messages",
      frames: [
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 8,
              output_tokens: 1,
              cache_read_input_tokens: 32,
              cache_creation_input_tokens: 0,
            },
          },
        },
        { type: "message_delta", usage: { output_tokens: 7 } },
      ],
      expected: {
        input_tokens: 8,
        output_tokens: 7,
        cache_read_input_tokens: 32,
        cache_creation_input_tokens: 0,
      },
    },
  ])(
    "retains unknown/zero/positive usage for $path",
    async ({ path, frames, expected }) => {
      globalThis.fetch = vi
        .fn<typeof fetch>()
        .mockResolvedValue(stream(frames).response);
      const observer = installFormalCacheObserver();
      await (
        await fetch(`https://zenmux.ai${path}`, { body: "{}", method: "POST" })
      ).text();
      await observer.drain();
      expect(generations(observer)[0].finalUsage).toEqual(expected);
      expect(generations(observer)[0].rawUsage).toHaveLength(frames.length);
      observer.restore();
    },
  );

  it("canonicalizes full native inputs and hashes stable prefixes without storing native content", async () => {
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response("{}")));
    const observer = installFormalCacheObserver();
    const stable = [
      { role: "system", content: "private system" },
      {
        role: "assistant",
        content: "private native",
        provider_native: { signature: "private signature" },
      },
    ];
    const body = {
      model: "openai/gpt-5",
      reasoning: { effort: "high", secret: "private reasoning" },
      tools: [
        { name: "private tool", description: "private tool description" },
      ],
      input: [...stable, { role: "user", content: "first question" }],
    };
    await fetch("https://zenmux.ai/api/v1/responses?token=private-query", {
      method: "POST",
      body: JSON.stringify(body),
    });
    await fetch("https://zenmux.ai/api/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        ...body,
        input: [...stable, { content: "second question", role: "user" }],
      }),
    });
    await observer.drain();
    const [first, second] = generations(observer);
    expect(first.prefixBeforeLatestUser).toEqual(second.prefixBeforeLatestUser);
    expect(first.input).not.toEqual(second.input);
    expect(first.inputPrefixes[1]).toEqual(second.inputPrefixes[1]);
    expect(first.system).toEqual(second.system);
    expect(first.tools).toEqual(second.tools);
    expect(first.reasoning.effort).toBe("high");
    expect(first.input.bytes).toBeGreaterThan(0);
    expect(first.input.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(observer.records)).not.toMatch(
      /private|question|signature|provider_native|description/,
    );
    observer.restore();
  });

  it("captures Anthropic adaptive effort and includes output configuration in the digest", async () => {
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response("{}")));
    const observer = installFormalCacheObserver();
    for (const effort of ["high", "max"]) {
      await fetch("https://zenmux.ai/api/anthropic/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "anthropic/claude-opus-4.6",
          thinking: { type: "adaptive" },
          output_config: { effort, privateValue: "private configuration" },
          messages: [],
        }),
      });
    }
    await observer.drain();
    expect(generations(observer)[0].reasoning).toMatchObject({
      effort: "high",
      thinkingType: "adaptive",
    });
    expect(generations(observer)[1].reasoning.effort).toBe("max");
    expect(generations(observer)[0].reasoning.config).not.toEqual(
      generations(observer)[1].reasoning.config,
    );
    expect(JSON.stringify(observer.records)).not.toContain("private");
    observer.restore();
  });

  it("audits unknown reasoning omission, encrypted include, and tool pairing without raw IDs", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response("{}")));
    globalThis.fetch = transport;
    const observer = installFormalCacheObserver();
    const init = {
      method: "POST",
      body: JSON.stringify({
        model: "openai/gpt-5.6-luna",
        include: ["reasoning.encrypted_content", "private-option"],
        input: [
          {
            type: "function_call",
            call_id: "private-call-id",
            name: "read",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "private-call-id",
            output: "private-result",
          },
        ],
      }),
    };
    await fetch("https://zenmux.ai/api/v1/responses", init);
    await observer.drain();
    const row = generations(observer)[0];
    expect(row.reasoning.controlFields).toEqual([]);
    expect(row.encryptedReasoningRequested).toBe(true);
    expect(row.toolPairing?.calls).toHaveLength(1);
    expect(row.toolPairing?.results).toEqual(row.toolPairing?.calls);
    expect(row.toolPairing?.calls[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(observer.records)).not.toContain("private");
    expect(transport.mock.calls[0][1]).toBe(init);
    observer.restore();
  });

  it("reads a clone of Request input without consuming its body", async () => {
    const request = new Request(url, {
      method: "POST",
      body: JSON.stringify({ model: "test/model", messages: [] }),
    });
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) => {
        expect(input).toBe(request);
        expect(await (input as Request).text()).toContain("test/model");
        return new Response("{}");
      });
    const observer = installFormalCacheObserver();
    await fetch(request);
    await observer.drain();
    expect(generations(observer)[0].model).toBe("test/model");
    observer.restore();
  });

  it("enforces a concurrent request cap and denies unrelated network before transport", async () => {
    const fake = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response("{}")));
    globalThis.fetch = fake;
    const observer = installFormalCacheObserver({ maxRequests: 1 });
    await expect(fetch("https://example.com/api/v1/responses")).rejects.toThrow(
      "NETWORK_DENIED",
    );
    await expect(
      fetch("https://zenmux.ai/unrelated/responses"),
    ).rejects.toThrow("NETWORK_DENIED");
    const first = fetch(url, { body: "{}", method: "POST" });
    await expect(fetch(url)).rejects.toThrow("REQUEST_LIMIT");
    await first;
    await observer.drain();
    expect(fake).toHaveBeenCalledTimes(1);
    expect(observer.records).toHaveLength(1);
    observer.restore();
  });

  it("drain waits for delayed headers and the cloned stream to complete", async () => {
    let sendHeaders!: (response: Response) => void;
    let closeStream!: () => void;
    globalThis.fetch = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          sendHeaders = resolve;
        }),
    );
    const observer = installFormalCacheObserver();
    const request = fetch(url, { method: "POST", body: "{}" });
    let drained = false;
    const draining = observer.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    const response = new Response(
      new ReadableStream({
        start(controller): void {
          controller.enqueue(
            new TextEncoder().encode('data: {"usage":{"prompt_tokens":4}}\n\n'),
          );
          closeStream = (): void => {
            controller.close();
          };
        },
      }),
    );
    sendHeaders(response);
    expect(await request).toBe(response);
    await Promise.resolve();
    expect(drained).toBe(false);
    closeStream();
    await draining;
    expect(drained).toBe(true);
    expect(generations(observer)[0].finalUsage).toEqual({ prompt_tokens: 4 });
    observer.restore();
  });

  it("drain settles after transport rejection without retaining the error text", async () => {
    const failure = new Error("private transport error");
    globalThis.fetch = vi.fn<typeof fetch>().mockRejectedValue(failure);
    const observer = installFormalCacheObserver();
    const request = fetch(url, { method: "POST", body: "{}" });
    const draining = observer.drain();
    await expect(request).rejects.toBe(failure);
    await draining;
    expect(generations(observer)[0].captureError).toBe("transport");
    expect(JSON.stringify(observer.records)).not.toContain("private transport");
    observer.restore();
  });

  it("records a sanitized stream failure without changing the returned stream", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller): void {
          controller.error(new Error("private failure"));
        },
      }),
    );
    globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue(response);
    const observer = installFormalCacheObserver();
    const returned = await fetch(url, { body: "{}", method: "POST" });
    expect(returned).toBe(response);
    await expect(returned.text()).rejects.toThrow("private failure");
    await observer.drain();
    expect(generations(observer)[0].captureError).toBe("response_stream");
    expect(JSON.stringify(observer.records)).not.toContain("private failure");
    observer.restore();
  });
});
