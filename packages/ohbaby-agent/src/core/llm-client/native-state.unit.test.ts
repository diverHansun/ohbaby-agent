import { it, expect } from "vitest";
import { streamResponse } from "./streaming.js";
import type { InterfaceProviderStreamEvent } from "../../services/interface-providers/types.js";
import type { LLMClientInstance, StreamingResponse } from "./types.js";
const output = {
  protocol: "anthropic" as const,
  items: [
    { type: "redacted_thinking" as const, data: "opaque" },
    { type: "text" as const, text: "done" },
  ],
};
function client(): LLMClientInstance {
  return {
    config: {
      provider: "test",
      model: "test",
      baseUrl: "https://test/v1",
      interfaceProvider: "anthropic",
      maxTokens: 500,
      modelProfiles: [
        {
          provider: "test",
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
      kind: "anthropic",
      client: {},
      isAbortError: () => false,
      streamResponse(): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        return Promise.resolve(
          (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            await Promise.resolve();
            yield {
              textDelta: "done",
              finishReason: "stop" as const,
              tokenUsage: {
                inputTokens: 100,
                outputTokens: 20,
                totalTokens: 120,
              },
            };
            yield { nativeOutput: output, reasoningTokens: 12 };
          })(),
        );
      },
    },
  };
}
it("publishes a final native state only after normal stream exhaustion", async () => {
  const frames: StreamingResponse[] = [];
  for await (const frame of streamResponse(client(), [
    { role: "user", content: "test" },
  ]))
    frames.push(frame);
  expect(frames.at(-1)).toMatchObject({
    modelState: {
      version: 1,
      output,
      origin: {
        provider: "test",
        model: "test",
        protocol: "anthropic",
        endpoint: "https://test/v1",
      },
      estimate: { tokens: 12, source: "reasoning" },
    },
  });
  expect(frames.slice(0, -1).every((frame) => !("modelState" in frame))).toBe(
    true,
  );
});
it("does not publish a state before a trailing provider error", async () => {
  const c = client();
  c.provider.streamResponse = (): Promise<
    AsyncIterable<InterfaceProviderStreamEvent>
  > =>
    Promise.resolve(
      (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
        await Promise.resolve();
        yield { nativeOutput: output, finishReason: "stop" as const };
        throw new Error("tail");
      })(),
    );
  const frames: StreamingResponse[] = [];
  await expect(async () => {
    for await (const frame of streamResponse(c, [])) frames.push(frame);
  }).rejects.toThrow();
  expect(frames.every((frame) => !("modelState" in frame))).toBe(true);
});

it.each([
  [0, 20, 0, "reasoning"],
  [undefined, 20, 20, "output"],
  [undefined, undefined, 500, "limit"],
] as const)(
  "uses one response estimate with reasoning=%s and output=%s",
  async (reasoningTokens, outputTokens, tokens, source) => {
    const c = client();
    c.provider.streamResponse = (): Promise<
      AsyncIterable<InterfaceProviderStreamEvent>
    > =>
      Promise.resolve(
        (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
          yield await Promise.resolve({
            textDelta: "done",
            nativeOutput: output,
            finishReason: "stop" as const,
            reasoningTokens,
            ...(outputTokens === undefined
              ? {}
              : {
                  tokenUsage: {
                    inputTokens: 100,
                    outputTokens,
                    totalTokens: 100 + outputTokens,
                  },
                }),
          });
        })(),
      );
    const frames: StreamingResponse[] = [];
    for await (const frame of streamResponse(c, [])) frames.push(frame);
    expect(frames.at(-1)?.modelState?.estimate).toEqual({ tokens, source });
    expect(frames.at(-1)?.tokenUsage?.outputTokens).toBe(outputTokens);
  },
);
