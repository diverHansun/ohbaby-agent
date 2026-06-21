import { describe, expect, it } from "vitest";
import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiCompactSessionResult,
  UiCompactSessionUsage,
  UiConnectModelResult,
  UiEvent,
  UiEventHandler,
  UiSetSearchApiKeyResult,
  UiSnapshot,
  UiUnsubscribe,
} from "ohbaby-sdk";
import { createDaemonServerApp } from "ohbaby-server";
import { createOhbabyWebRuntime } from "./client.js";
import type { OhbabyBootstrapConfig } from "./wire.js";

const timestamp = "2026-06-12T00:00:00.000Z";
const authToken = "token_1";

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

function setSearchApiKeyResult(): UiSetSearchApiKeyResult {
  return {
    apiKeyEnv: "TAVILY_API_KEY",
    envPath: ".env",
    provider: "tavily",
    searchJsonPath: "search.json",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function urlFromRequestInput(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error(message);
}

class FakeBackend implements UiBackendClient {
  readonly handlers = new Set<UiEventHandler>();
  readonly submitted: {
    readonly text: string;
    readonly options?: SubmitPromptOptions;
  }[] = [];
  private snapshot = emptySnapshot();

  getSnapshot(): Promise<UiSnapshot> {
    return Promise.resolve(this.snapshot);
  }

  getContextWindowUsage(): Promise<null> {
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

  submitPrompt(text: string, options?: SubmitPromptOptions): Promise<void> {
    this.submitted.push({ text, ...(options ? { options } : {}) });
    const sessionId = options?.sessionId ?? "session_1";
    const session = {
      createdAt: timestamp,
      id: sessionId,
      messages: [],
      title: "Session",
      updatedAt: timestamp,
    };
    this.snapshot = {
      ...this.snapshot,
      activeSessionId: sessionId,
      sessions: [session],
    };
    this.emit({ session, type: "session.updated" });
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

  setSearchApiKey(): ReturnType<UiBackendClient["setSearchApiKey"]> {
    return Promise.resolve(setSearchApiKeyResult());
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

  private emit(event: UiEvent): void {
    for (const handler of Array.from(this.handlers)) {
      handler(event);
    }
  }
}

describe("ohbaby-web with ohbaby-server /v1", () => {
  it("connects through app.request and consumes prompt events", async () => {
    const backend = new FakeBackend();
    const server = createDaemonServerApp({
      authToken,
      backend,
      createSessionId: () => "session_generated",
      packageVersion: "0.1.6-test",
    });
    await server.start();
    try {
      const fetchImpl: typeof fetch = (input, init = {}) => {
        const url = new URL(urlFromRequestInput(input));
        return Promise.resolve(
          server.app.request(`${url.pathname}${url.search}`, {
            body: init.body,
            headers: init.headers,
            method: init.method,
            signal: init.signal,
          }),
        );
      };
      const config: OhbabyBootstrapConfig = {
        baseUrl: "http://127.0.0.1:4096",
        clientId: "client_web",
        startupIntent: { startupSessionMode: { type: "fresh" } },
        token: authToken,
      };
      const runtime = createOhbabyWebRuntime(config, { fetch: fetchImpl });
      await runtime.ready;

      await runtime.client.submitPrompt({ text: "hello" });

      await waitFor(
        () =>
          runtime.store
            .getSnapshot()
            .view.snapshot?.sessions.some(
              (session) => session.id === "session_generated",
            ) === true,
        "timed out waiting for server event",
      );
      expect(backend.submitted).toEqual([
        {
          options: { sessionId: "session_generated" },
          text: "hello",
        },
      ]);
      expect(runtime.store.getSnapshot()).toMatchObject({
        connectionState: "live",
        view: {
          snapshot: {
            sessions: [{ id: "session_generated" }],
          },
        },
      });
      await runtime.client.close();
    } finally {
      await server.dispose();
    }
  });
});
