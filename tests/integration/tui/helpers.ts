import type { LLMClientInstance } from "../../../packages/ohbaby-agent/src/core/llm-client/index.js";
import type {
  ProviderRequest,
  ProviderStreamEvent,
} from "../../../packages/ohbaby-agent/src/services/providers/index.js";
import { createTemporarySessionTitle } from "../../../packages/ohbaby-agent/src/services/session/index.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

const TITLE_GENERATION_PROMPT_MARKER =
  "Generate a concise title for a coding-agent chat session.";

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
        request: ProviderRequest,
      ): Promise<AsyncIterable<ProviderStreamEvent>> {
        if (isSessionTitleGenerationRequest(request)) {
          return Promise.resolve(
            createProviderStream([
              {
                textDelta: titleTextForSessionTitleRequest(request),
                finishReason: "stop",
              },
            ]),
          );
        }
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
        if (isSessionTitleGenerationRequest(request)) {
          return Promise.resolve(
            createProviderStream([
              {
                textDelta: titleTextForSessionTitleRequest(request),
                finishReason: "stop",
              },
            ]),
          );
        }
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

function isSessionTitleGenerationRequest(request: ProviderRequest): boolean {
  return JSON.stringify(request.messages).includes(TITLE_GENERATION_PROMPT_MARKER);
}

function titleTextForSessionTitleRequest(request: ProviderRequest): string {
  const firstMessage = firstUserMessageForSessionTitleRequest(request);
  return createTemporarySessionTitle(firstMessage);
}

function firstUserMessageForSessionTitleRequest(
  request: ProviderRequest,
): string {
  const userMessage = request.messages.find((message) => message.role === "user");
  const content = typeof userMessage?.content === "string" ? userMessage.content : "";
  const marker = "First user message:\n";
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) {
    return "Fake session title";
  }
  return content.slice(markerIndex + marker.length);
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
  timeoutMs = 5_000,
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
  const lines = stripAnsi(frame).split(/\r?\n/u);
  return (
    [...lines]
      .reverse()
      .map(normalizePromptFrameLine)
      .find((line) => line.trimStart().startsWith(">")) ?? ""
  );
}

export function promptIsReady(frame: string): boolean {
  const line = promptLine(frame).replace(/[^\x00-\x7F]/gu, "");

  return line.trim() === ">";
}

function stripAnsi(input: string): string {
  return input.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}

function normalizePromptFrameLine(line: string): string {
  const trimmed = line.trim();
  const promptStart = trimmed.indexOf("> ");
  if (promptStart >= 0) {
    return trimmed
      .slice(promptStart)
      .replace(/[^\x00-\x7F]+$/gu, "")
      .trimEnd();
  }

  return line;
}
