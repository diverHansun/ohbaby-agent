import { describe, expect, it, vi } from "vitest";
import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiCompactSessionResult,
  UiCompactSessionUsage,
  UiConnectModelResult,
  UiEvent,
  UiEventHandler,
  UiSnapshot,
  UiUnsubscribe,
} from "ohbaby-sdk";
import { createRemoteUiBackendClient } from "./client.js";
import { createDaemonHttpServer } from "./server.js";

const timestamp = "2026-06-12T00:00:00.000Z";

function emptySnapshot(): UiSnapshot {
  return {
    activeSessionId: null,
    permission: {
      level: "default",
      mode: "auto",
      sessionRules: [],
    },
    permissions: [],
    runs: [],
    sessions: [],
    status: { kind: "idle" },
  };
}

function compactUsage(): UiCompactSessionUsage {
  return {
    contextLimit: 100,
    currentTokens: 1,
    modelId: "fake-model",
    remainingTokens: 99,
    shouldCompress: false,
    usageRatio: 0.01,
  };
}

function compactResult(): UiCompactSessionResult {
  const usage = compactUsage();
  return {
    sessionId: "session_1",
    status: "not-needed",
    usageAfter: usage,
    usageBefore: usage,
  };
}

function connectModelResult(): UiConnectModelResult {
  return {
    apiKeyEnv: "FAKE_API_KEY",
    baseUrl: "https://example.invalid/v1",
    contextWindowSource: "default",
    contextWindowTokens: 100,
    envPath: ".env",
    interfaceProvider: "openai-compatible",
    model: "fake-model",
    modelJsonPath: "model.json",
    provider: "fake",
    saved: true,
  };
}

function sessionUpdated(
  id = "session_1",
): Extract<UiEvent, { type: "session.updated" }> {
  return {
    session: {
      createdAt: timestamp,
      id,
      messages: [],
      title: "Session",
      updatedAt: timestamp,
    },
    type: "session.updated",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function eventuallyEmit(
  backend: FakeBackend,
  event: UiEvent,
  until: Promise<unknown>,
): Promise<void> {
  const timer = setInterval(() => {
    backend.emit(event);
  }, 10);
  try {
    await until;
  } finally {
    clearInterval(timer);
  }
}

class FakeBackend implements UiBackendClient {
  readonly handlers = new Set<UiEventHandler>();
  readonly submitted: {
    readonly text: string;
    readonly options?: SubmitPromptOptions;
  }[] = [];
  submitError: Error | undefined;

  constructor(private readonly snapshot: UiSnapshot = emptySnapshot()) {}

  emit(event: UiEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  getSnapshot(): Promise<UiSnapshot> {
    return Promise.resolve(this.snapshot);
  }

  getContextWindowUsage(): ReturnType<
    UiBackendClient["getContextWindowUsage"]
  > {
    return Promise.resolve(null);
  }

  subscribeEvents(handler: UiEventHandler): UiUnsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  listCommands(): ReturnType<UiBackendClient["listCommands"]> {
    return Promise.resolve({ commands: [], version: "v1" });
  }

  submitPrompt(
    text: string,
    options?: SubmitPromptOptions,
  ): Promise<void> {
    if (this.submitError) {
      return Promise.reject(this.submitError);
    }
    this.submitted.push({ text, ...(options ? { options } : {}) });
    return Promise.resolve();
  }

  compactSession(): ReturnType<UiBackendClient["compactSession"]> {
    return Promise.resolve(compactResult());
  }

  getCurrentModel(): ReturnType<UiBackendClient["getCurrentModel"]> {
    return Promise.resolve(null);
  }

  connectModel(): ReturnType<UiBackendClient["connectModel"]> {
    return Promise.resolve(connectModelResult());
  }

  executeCommand(): Promise<void> {
    return Promise.resolve();
  }

  respondPermission(): Promise<void> {
    return Promise.resolve();
  }

  respondInteraction(): Promise<void> {
    return Promise.resolve();
  }

  abortRun(): Promise<void> {
    return Promise.resolve();
  }
}

async function withRemoteClient<T>(
  backend: FakeBackend,
  callback: (
    client: ReturnType<typeof createRemoteUiBackendClient>,
  ) => Promise<T>,
): Promise<T> {
  const server = createDaemonHttpServer({
    backend,
    host: "127.0.0.1",
    port: 0,
  });
  await server.start();
  const client = createRemoteUiBackendClient({
    clientId: "client_a",
    host: "127.0.0.1",
    port: server.port,
  });
  try {
    return await callback(client);
  } finally {
    await client.dispose();
    await server.stop();
  }
}

describe("createRemoteUiBackendClient", () => {
  it("returns snapshots through the daemon rpc endpoint", async () => {
    const snapshot = {
      ...emptySnapshot(),
      activeSessionId: "session_1",
      sessions: [sessionUpdated().session],
    } satisfies UiSnapshot;

    await withRemoteClient(new FakeBackend(snapshot), async (client) => {
      await expect(client.getSnapshot()).resolves.toEqual(snapshot);
    });
  });

  it("submits prompts with options through the daemon rpc endpoint", async () => {
    const backend = new FakeBackend();

    await withRemoteClient(backend, async (client) => {
      await client.submitPrompt("hello daemon", { sessionId: "session_1" });

      expect(backend.submitted).toEqual([
        {
          options: { sessionId: "session_1" },
          text: "hello daemon",
        },
      ]);
    });
  });

  it("receives ui events from the daemon SSE endpoint", async () => {
    const backend = new FakeBackend();

    await withRemoteClient(backend, async (client) => {
      const eventPromise = new Promise<UiEvent>((resolve) => {
        client.subscribeEvents(resolve);
      });

      await eventuallyEmit(backend, sessionUpdated(), eventPromise);

      await expect(eventPromise).resolves.toEqual(sessionUpdated());
    });
  });

  it("stops delivering events after the last unsubscribe", async () => {
    const backend = new FakeBackend();

    await withRemoteClient(backend, async (client) => {
      let resolveFirst!: () => void;
      const firstEvent = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      const handler = vi.fn(() => {
        resolveFirst();
      });
      const unsubscribe = client.subscribeEvents(handler);

      await eventuallyEmit(backend, sessionUpdated("session_1"), firstEvent);
      await delay(20);
      unsubscribe();
      const callsAfterUnsubscribe = handler.mock.calls.length;

      backend.emit(sessionUpdated("session_2"));
      await delay(50);

      expect(handler).toHaveBeenCalledTimes(callsAfterUnsubscribe);
    });
  });

  it("rejects failed rpc responses with the server error message", async () => {
    const backend = new FakeBackend();
    backend.submitError = new Error("backend exploded");

    await withRemoteClient(backend, async (client) => {
      await expect(client.submitPrompt("boom")).rejects.toThrow(
        "backend exploded",
      );
    });
  });
});
