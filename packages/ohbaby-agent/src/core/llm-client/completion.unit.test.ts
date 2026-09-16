import { describe, expect, it, vi } from "vitest";
import { streamResponse } from "./streaming.js";
import type { LLMClientInstance, StreamingResponse } from "./types.js";
import type { InterfaceProviderStreamEvent } from "../../services/interface-providers/types.js";

const usage = { inputTokens: 12, outputTokens: 3, totalTokens: 15 };
function client(
  events: InterfaceProviderStreamEvent[],
  after?: () => void,
): LLMClientInstance {
  return {
    config: {
      provider: "test",
      model: "test",
      baseUrl: "https://test/v1",
      interfaceProvider: "openai-compatible",
      maxTokens: 500,
      modelProfiles: [
        {
          model: "test",
          contextWindowTokens: 128000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
    },
    provider: {
      id: "test",
      kind: "openai-compatible",
      client: {},
      isAbortError: () => false,
      streamResponse: vi.fn(() =>
        Promise.resolve(
          (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            for (const event of events) yield await Promise.resolve(event);
            after?.();
          })(),
        ),
      ),
    },
  };
}
async function collect(
  c: LLMClientInstance,
  signal?: AbortSignal,
): Promise<StreamingResponse[]> {
  const frames: StreamingResponse[] = [];
  for await (const frame of streamResponse(c, [], { signal }))
    frames.push(frame);
  return frames;
}
describe("stream completion acceptance", () => {
  it("publishes one final snapshot after EOF with trailing usage", async () => {
    let exhausted = false;
    const c = client(
      [{ textDelta: "done", finishReason: "stop" }, { tokenUsage: usage }],
      () => {
        exhausted = true;
      },
    );
    const frames: StreamingResponse[] = [];
    for await (const frame of streamResponse(c, [])) {
      if (frame.isComplete) expect(exhausted).toBe(true);
      frames.push(frame);
    }
    expect(frames.filter((f) => f.isComplete)).toHaveLength(1);
    expect(frames.at(-1)?.tokenUsage).toEqual(usage);
  });
  it.each<{ events: InterfaceProviderStreamEvent[] }>([
    { events: [] },
    { events: [{ tokenUsage: usage }] },
    { events: [{ textDelta: "partial" }] },
    { events: [{ reasoningTextDelta: "thinking" }] },
  ])("rejects EOF without provider terminal: $events", async ({ events }) => {
    await expect(collect(client(events))).rejects.toMatchObject({
      name: "ProviderStreamInterruptedError",
      source: "eof",
    });
  });
  it("accepts an explicit empty stop", async () => {
    const frames = await collect(client([{ finishReason: "stop" }]));
    expect(frames.filter((f) => f.isComplete)).toHaveLength(1);
    expect(frames.at(-1)?.messageSnapshot.content).toBeNull();
  });
  it("does not publish completion before a trailing transport failure", async () => {
    const c = client([{ textDelta: "partial", finishReason: "stop" }], () => {
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    });
    const frames: StreamingResponse[] = [];
    await expect(async () => {
      for await (const frame of streamResponse(c, [])) frames.push(frame);
    }).rejects.toMatchObject({ source: "transport" });
    expect(frames.filter((f) => f.isComplete)).toHaveLength(0);
  });
  it("classifies provider abort without a local signal as failure without retry", async () => {
    let attempts = 0;
    const c = client([], () => {
      attempts += 1;
      throw new Error("provider abort");
    });
    c.provider.isAbortError = (): boolean => true;
    await expect(collect(c)).rejects.toMatchObject({
      name: "ProviderStreamInterruptedError",
      source: "provider_abort",
    });
    expect(attempts).toBe(1);
  });
  it("returns empty local abort without manufacturing assistant text", async () => {
    const controller = new AbortController();
    const frames = await collect(
      client([], () => {
        controller.abort();
      }),
      controller.signal,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      isComplete: true,
      streamStopReason: "user_aborted",
      messageSnapshot: { content: null },
    });
    expect(frames[0]?.finishReason).toBeUndefined();
  });
});

it("does not classify invalid native projection as transport or publish completion", async () => {
  const c = client([
    {
      textDelta: "visible",
      finishReason: "stop",
      nativeOutput: {
        protocol: "anthropic",
        items: [{ type: "text", text: "different" }],
      },
    },
  ]);
  const frames: StreamingResponse[] = [];
  await expect(async () => {
    for await (const frame of streamResponse(c, [])) frames.push(frame);
  }).rejects.toMatchObject({
    name: "ProviderStreamInterruptedError",
    source: "protocol",
  });
  expect(
    frames.every(
      (frame) => !frame.isComplete && frame.modelState === undefined,
    ),
  ).toBe(true);
});

it("does not classify an unknown late failure as transport", async () => {
  const c = client([{ textDelta: "partial", finishReason: "stop" }], () => {
    throw new Error("unknown");
  });
  await expect(collect(c)).rejects.toMatchObject({
    name: "ProviderStreamInterruptedError",
    source: undefined,
  });
});

it("rejects damaged tool JSON before final completion", async () => {
  const c = client([
    {
      finishReason: "tool_calls",
      toolCallDeltas: [
        { index: 0, id: "bad", name: "read_file", argumentsDelta: "{" },
      ],
    },
  ]);
  const frames: StreamingResponse[] = [];
  await expect(async () => {
    for await (const frame of streamResponse(c, [])) frames.push(frame);
  }).rejects.toMatchObject({ name: "ToolCallParseError" });
  expect(
    frames.every(
      (frame) => !frame.isComplete && frame.parsedToolCalls === undefined,
    ),
  ).toBe(true);
});
