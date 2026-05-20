import type { LLMClientInstance } from "../../../packages/ohbaby-agent/src/core/llm-client/index.js";
import type {
  ProviderRequest,
  ProviderStreamEvent,
} from "../../../packages/ohbaby-agent/src/services/providers/index.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

export interface FrameSource {
  lastFrame(): string | undefined;
}

export function createProviderStream(
  events: readonly ProviderStreamEvent[],
): AsyncGenerator<ProviderStreamEvent, void, unknown> {
  return (async function* (): AsyncGenerator<
    ProviderStreamEvent,
    void,
    unknown
  > {
    for (const event of events) {
      yield await Promise.resolve(event);
    }
  })();
}

export function createFakeLLMClient(
  events: readonly ProviderStreamEvent[],
): LLMClientInstance<FakeSdkClient> {
  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(
        _request: ProviderRequest,
      ): Promise<AsyncIterable<ProviderStreamEvent>> {
        return Promise.resolve(createProviderStream(events));
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      baseUrl: "https://example.invalid/v1",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

export function createSequentialFakeLLMClient(
  eventBatches: readonly (readonly ProviderStreamEvent[])[],
  requests: ProviderRequest[] = [],
): LLMClientInstance<FakeSdkClient> {
  let nextBatch = 0;

  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(
        request: ProviderRequest,
      ): Promise<AsyncIterable<ProviderStreamEvent>> {
        if (nextBatch >= eventBatches.length) {
          return Promise.reject(new Error("No fake LLM response configured"));
        }
        requests.push(request);
        const events = eventBatches[nextBatch];
        nextBatch += 1;
        return Promise.resolve(createProviderStream(events));
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      baseUrl: "https://example.invalid/v1",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

export function writeToolCallEvent(input: {
  readonly callId: string;
  readonly content: string;
  readonly filePath: string;
}): ProviderStreamEvent {
  return {
    toolCallDeltas: [
      {
        argumentsDelta: JSON.stringify({
          content: input.content,
          file_path: input.filePath,
        }),
        id: input.callId,
        index: 0,
        name: "write",
      },
    ],
    finishReason: "tool_calls",
  };
}

export async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export async function waitForFrame(
  app: FrameSource,
  predicate: (frame: string) => boolean,
  timeoutMs = 2_000,
): Promise<string> {
  const startedAt = Date.now();
  let lastFrame = "";
  while (Date.now() - startedAt < timeoutMs) {
    await flush();
    lastFrame = app.lastFrame() ?? "";
    if (predicate(lastFrame)) {
      return lastFrame;
    }
  }
  throw new Error(`Timed out waiting for frame. Last frame:\n${lastFrame}`);
}

export function promptLine(frame: string): string {
  const lines = frame.split(/\r?\n/u);
  return (
    [...lines]
      .reverse()
      .find((line) => line.trimStart().startsWith("ohbaby >")) ?? ""
  );
}

export function promptIsReady(frame: string): boolean {
  const line = promptLine(frame);

  return (
    line.includes("ohbaby >") &&
    line.includes("message") &&
    line.includes("|")
  );
}
