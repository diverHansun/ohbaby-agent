import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  readonly abortedRunIds: (string | undefined)[] = [];
  readonly permissionResponses: {
    readonly requestId: string;
    readonly response: Parameters<UiBackendClient["respondPermission"]>[1];
  }[] = [];
  readonly submitted: {
    readonly text: string;
    readonly options?: SubmitPromptOptions;
  }[] = [];

  constructor(private readonly snapshot: UiSnapshot = emptySnapshot()) {}

  emit(event: Parameters<UiEventHandler>[0]): void {
    for (const handler of Array.from(this.handlers)) {
      handler(event);
    }
  }

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

  respondPermission(
    requestId: string,
    response: Parameters<UiBackendClient["respondPermission"]>[1],
  ): Promise<void> {
    this.permissionResponses.push({
      requestId,
      response,
    });
    return Promise.resolve();
  }

  respondInteraction(): Promise<void> {
    return Promise.resolve();
  }

  abortRun(runId?: string): Promise<void> {
    this.abortedRunIds.push(runId);
    return Promise.resolve();
  }
}

function createApp(
  backend = new FakeBackend(),
  options: Partial<Parameters<typeof createDaemonServerApp>[0]> = {},
): ReturnType<typeof createDaemonServerApp> {
  return createDaemonServerApp({
    authToken,
    backend,
    packageVersion: "0.1.5-test",
    ...options,
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
    ).toThrow(
      "clientDisconnectRetentionMs must be a non-negative finite number",
    );

    expect(() =>
      createDaemonServerApp({
        authToken,
        backend: new FakeBackend(),
        clientDisconnectRetentionMs: Number.POSITIVE_INFINITY,
        packageVersion: "0.1.5-test",
      }),
    ).toThrow(
      "clientDisconnectRetentionMs must be a non-negative finite number",
    );
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
      const response = await handle.app.request(
        "/api/events?clientId=client_a",
        {
          headers: authHeaders(),
        },
      );

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

  it("serves an OpenAPI document for web clients", async () => {
    const handle = createApp();
    await handle.start();
    try {
      const response = await handle.app.request("/doc");

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        readonly openapi: string;
        readonly paths: Record<string, unknown>;
      };
      expect(body.openapi).toBe("3.1.0");
      expect(Object.keys(body.paths)).toEqual(
        expect.arrayContaining([
          "/v1/clients",
          "/v1/events",
          "/v1/prompts",
          "/v1/snapshot",
        ]),
      );
    } finally {
      await handle.dispose();
    }
  });

  it("registers a web client and returns a projected snapshot with seqNum", async () => {
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
      const clientResponse = await handle.app.request("/v1/clients", {
        body: JSON.stringify({
          clientId: "client_web",
          startupIntent: { resumeSessionId: "session_1" },
        }),
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
        },
        method: "POST",
      });

      expect(clientResponse.status).toBe(200);
      await expect(clientResponse.json()).resolves.toEqual({
        clientId: "client_web",
        ok: true,
      });

      const snapshotResponse = await handle.app.request("/v1/snapshot", {
        headers: {
          ...authHeaders(),
          "x-ohbaby-client-id": "client_web",
        },
      });

      expect(snapshotResponse.status).toBe(200);
      await expect(snapshotResponse.json()).resolves.toMatchObject({
        ok: true,
        seqNum: 0,
        snapshot: {
          activeSessionId: "session_1",
          sessions: [{ id: "session_1" }],
        },
      });
    } finally {
      await handle.dispose();
    }
  });

  it("serves the web SSE hello event", async () => {
    const handle = createApp();
    await handle.start();
    try {
      const response = await handle.app.request("/v1/events", {
        headers: {
          ...authHeaders(),
          "x-ohbaby-client-id": "client_web",
        },
      });

      expect(response.status).toBe(200);
      await expect(readSseData(response)).resolves.toEqual({
        clientId: "client_web",
        type: "hello",
      });
    } finally {
      await handle.dispose();
    }
  });

  it("accepts web prompts asynchronously", async () => {
    const backend = new FakeBackend();
    const handle = createApp(backend, {
      createSessionId: () => "session_generated",
    });
    await handle.start();
    try {
      await handle.app.request("/v1/clients", {
        body: JSON.stringify({ clientId: "client_web" }),
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
        },
        method: "POST",
      });
      const response = await handle.app.request("/v1/prompts", {
        body: JSON.stringify({ text: "hello" }),
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "x-ohbaby-client-id": "client_web",
        },
        method: "POST",
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        sessionId: "session_generated",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(backend.submitted).toEqual([
        {
          options: { sessionId: "session_generated" },
          text: "hello",
        },
      ]);
    } finally {
      await handle.dispose();
    }
  });

  it("serves web assets with injected bootstrap config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-web-assets-"));
    await writeFile(
      join(tempDir, "index.html"),
      "<!doctype html><html><head></head><body></body></html>",
      "utf8",
    );
    const handle = createApp(new FakeBackend(), {
      webAssets: { directory: tempDir },
    });
    await handle.start();
    try {
      const response = await handle.app.request("/", {
        headers: { accept: "text/html" },
      });

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("window.__OHBABY__=");
      expect(html).toContain('"token":"token_1"');
      expect(html).toContain('"startupSessionMode":{"type":"fresh"}');
    } finally {
      await handle.dispose();
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
