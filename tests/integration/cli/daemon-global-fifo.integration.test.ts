import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMClientInstance } from "../../../packages/ohbaby-agent/src/core/llm-client/index.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../../../packages/ohbaby-agent/src/services/interface-providers/index.js";
import {
  createRemoteUiBackendClient,
  startDaemonServer,
} from "../../../packages/ohbaby-server/src/index.js";
import { createTemporarySessionTitle } from "../../../packages/ohbaby-agent/src/services/session/index.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

class FakeAbortError extends Error {
  constructor() {
    super("fake provider aborted");
    this.name = "FakeAbortError";
  }
}

const TITLE_GENERATION_PROMPT_MARKER =
  "Generate a concise title for a coding-agent chat session.";
const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirectories.push(directory);
  return directory;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function createProviderStream(
  events: readonly InterfaceProviderStreamEvent[],
): AsyncGenerator<InterfaceProviderStreamEvent, void, unknown> {
  return (async function* (): AsyncGenerator<
    InterfaceProviderStreamEvent,
    void,
    unknown
  > {
    for (const event of events) {
      yield await Promise.resolve(event);
    }
  })();
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

function lastUserMessageText(request: InterfaceProviderRequest): string {
  const userMessage = [...request.messages]
    .reverse()
    .find((message) => message.role === "user");
  return typeof userMessage?.content === "string" ? userMessage.content : "";
}

function isSessionTitleGenerationRequest(
  request: InterfaceProviderRequest,
): boolean {
  return JSON.stringify(request.messages).includes(
    TITLE_GENERATION_PROMPT_MARKER,
  );
}

function titleTextForSessionTitleRequest(
  request: InterfaceProviderRequest,
): string {
  const content = lastUserMessageText(request);
  const marker = "First user message:\n";
  const markerIndex = content.indexOf(marker);
  return createTemporarySessionTitle(
    markerIndex < 0 ? "Fake session" : content.slice(markerIndex + marker.length),
  );
}

function createBlockingFifoLlmClient(input: {
  readonly firstStarted: Deferred<AbortSignal | undefined>;
  readonly secondStarted: Deferred<void>;
  readonly runOrder: string[];
}): LLMClientInstance<FakeSdkClient> {
  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
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
        const text = lastUserMessageText(request);
        if (text.includes("first blocking")) {
          input.runOrder.push("first");
          input.firstStarted.resolve(request.signal);
          return Promise.resolve(
            (async function* (): AsyncGenerator<
              InterfaceProviderStreamEvent,
              void,
              unknown
            > {
              await waitForAbort(request.signal);
              throw new FakeAbortError();
            })(),
          );
        }
        if (text.includes("second queued")) {
          input.runOrder.push("second");
          input.secondStarted.resolve();
          return Promise.resolve(
            createProviderStream([
              { textDelta: "second done", finishReason: "stop" },
            ]),
          );
        }
        input.runOrder.push("seed");
        return Promise.resolve(
          createProviderStream([{ textDelta: "seed done", finishReason: "stop" }]),
        );
      },
      isAbortError(error: unknown): boolean {
        return error instanceof FakeAbortError;
      },
    },
    config: {
      provider: "fake",
      model: "fake-model",
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 128,
    },
  };
}

describe("daemon global FIFO", () => {
  it("orders same-session prompts across remote clients and drains after abort", async () => {
    const home = await tempDirectory("ohbaby-daemon-fifo-");
    const firstStarted = deferred<AbortSignal | undefined>();
    const secondStarted = deferred<void>();
    const runOrder: string[] = [];
    const authToken = "token_1";
    const daemon = await startDaemonServer({
      authToken,
      dbPath: join(home, "agent.db"),
      host: "127.0.0.1",
      llmClient: createBlockingFifoLlmClient({
        firstStarted,
        runOrder,
        secondStarted,
      }),
      pidFilePath: join(home, "daemon.pid"),
      port: 0,
      stateFilePath: join(home, "daemon-state.json"),
      workdir: home,
    });
    const clientA = createRemoteUiBackendClient({
      authToken,
      clientId: "terminal_a",
      directory: home,
      host: daemon.host,
      port: daemon.port,
    });
    const clientB = createRemoteUiBackendClient({
      authToken,
      clientId: "terminal_b",
      directory: home,
      host: daemon.host,
      port: daemon.port,
    });

    try {
      await clientA.submitPrompt("seed session");
      const sessionId = (await clientA.getSnapshot()).activeSessionId;
      if (!sessionId) {
        throw new Error("expected seeded session");
      }

      const first = clientA.submitPrompt("first blocking", { sessionId });
      await firstStarted.promise;
      const second = clientB.submitPrompt("second queued", { sessionId });
      const beforeAbort = await Promise.race([
        secondStarted.promise.then(() => "started" as const),
        new Promise<"pending">((resolve) => {
          setTimeout(() => {
            resolve("pending");
          }, 80);
        }),
      ]);
      expect(beforeAbort).toBe("pending");

      await clientA.abortRun();
      await first.catch(() => undefined);
      await secondStarted.promise;
      await second;

      expect(runOrder).toEqual(["seed", "first", "second"]);
    } finally {
      await clientA.dispose();
      await clientB.dispose();
      await daemon.stop();
    }
  }, 30_000);
});
