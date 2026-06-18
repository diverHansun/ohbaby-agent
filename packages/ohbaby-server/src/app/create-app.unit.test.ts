import { describe, expect, it, vi } from "vitest";
import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiCompactSessionResult,
  UiCompactSessionUsage,
  UiConnectModelResult,
  UiEventHandler,
  UiSetSearchApiKeyResult,
  UiSnapshot,
  UiUnsubscribe,
} from "ohbaby-sdk";
import { daemonAuthHeader } from "../auth/token.js";
import { createDaemonServerApp } from "./create-app.js";

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

class FakeBackend implements UiBackendClient {
  readonly handlers = new Set<UiEventHandler>();
  readonly submitted: {
    readonly text: string;
    readonly options?: SubmitPromptOptions;
  }[] = [];

  constructor(private readonly snapshot: UiSnapshot = emptySnapshot()) {}

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
}

function createApp(backend = new FakeBackend()): ReturnType<
  typeof createDaemonServerApp
> {
  return createDaemonServerApp({
    authToken,
    backend,
    packageVersion: "0.1.5-test",
  });
}

function authHeaders(): Record<string, string> {
  return { authorization: daemonAuthHeader(authToken) };
}

async function readSseData(response: Response): Promise<unknown> {
  const reader = response.body?.getReader() as
    | ReadableStreamDefaultReader<Uint8Array>
    | undefined;
  if (!reader) {
    throw new Error("missing response body");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const boundary = buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length);
      if (!data) {
        throw new Error(`SSE frame missing data: ${frame}`);
      }
      await reader.cancel();
      return JSON.parse(data) as unknown;
    }
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error("SSE stream ended before an event arrived");
    }
    buffer += decoder.decode(chunk.value, { stream: true });
  }
}

describe("createDaemonServerApp", () => {
  it("serves authenticated health checks", async () => {
    const handle = createApp();
    await handle.start();
    try {
      const response = await handle.app.request("/api/health", {
        headers: authHeaders(),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        packageVersion: "0.1.5-test",
      });
    } finally {
      await handle.dispose();
    }
  });

  it("requires a configured auth token", () => {
    expect(() =>
      createDaemonServerApp({
        backend: new FakeBackend(),
        packageVersion: "0.1.5-test",
      }),
    ).toThrow("Daemon auth token is required");
  });

  it("requires a finite non-negative disconnect retention window", () => {
    expect(() =>
      createDaemonServerApp({
        authToken,
        backend: new FakeBackend(),
        clientDisconnectRetentionMs: -1,
        packageVersion: "0.1.5-test",
      }),
    ).toThrow("clientDisconnectRetentionMs must be a non-negative finite number");

    expect(() =>
      createDaemonServerApp({
        authToken,
        backend: new FakeBackend(),
        clientDisconnectRetentionMs: Number.POSITIVE_INFINITY,
        packageVersion: "0.1.5-test",
      }),
    ).toThrow("clientDisconnectRetentionMs must be a non-negative finite number");
  });

  it("rejects requests when auth headers are missing", async () => {
    const handle = createApp();
    await handle.start();
    try {
      const missingHeader = await handle.app.request("/api/health");
      expect(missingHeader.status).toBe(401);
    } finally {
      await handle.dispose();
    }
  });

  it("preserves jsonrpc success response shape", async () => {
    const snapshot = {
      ...emptySnapshot(),
      activeSessionId: "session_1",
      sessions: [
        {
          createdAt: timestamp,
          id: "session_1",
          messages: [],
          title: "Session",
          updatedAt: timestamp,
        },
      ],
    } satisfies UiSnapshot;
    const handle = createApp(new FakeBackend(snapshot));
    await handle.start();
    try {
      const response = await handle.app.request("/api/rpc", {
        body: JSON.stringify({
          clientId: "client_1",
          id: "rpc_1",
          method: "getSnapshot",
          params: [],
        }),
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: "rpc_1",
        ok: true,
        result: snapshot,
      });
    } finally {
      await handle.dispose();
    }
  });

  it("serves the compatible SSE hello event", async () => {
    const onClientConnected = vi.fn();
    const onClientDisconnected = vi.fn();
    const handle = createDaemonServerApp({
      authToken,
      backend: new FakeBackend(),
      onClientConnected,
      onClientDisconnected,
      packageVersion: "0.1.5-test",
    });
    await handle.start();
    try {
      const response = await handle.app.request("/api/events?clientId=client_a", {
        headers: authHeaders(),
      });

      expect(response.status).toBe(200);
      await expect(readSseData(response)).resolves.toEqual({
        clientId: "client_a",
        type: "hello",
      });
      expect(onClientConnected).toHaveBeenCalledWith("client_a");
    } finally {
      await handle.dispose();
    }
  });
});
