import { describe, expect, it } from "vitest";
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

function sessionUpdated(): UiEvent {
  return {
    session: {
      createdAt: timestamp,
      id: "session_1",
      messages: [],
      title: "Session",
      updatedAt: timestamp,
    },
    type: "session.updated",
  };
}

function runUpdated(runId: string): UiEvent {
  return {
    run: {
      id: runId,
      sessionId: "session_1",
      startedAt: timestamp,
      status: { kind: "running", runId },
      updatedAt: timestamp,
    },
    type: "run.updated",
  };
}

function permissionRequested(runId: string): Extract<
  UiEvent,
  { type: "permission.requested" }
> {
  return {
    request: {
      choices: [{ id: "allow", intent: "allow", label: "Allow" }],
      description: "Allow tool",
      id: `permission_${runId}`,
      runId,
      title: "Tool permission",
    },
    type: "permission.requested",
  };
}

class FakeBackend implements UiBackendClient {
  readonly handlers = new Set<UiEventHandler>();
  readonly submitted: {
    readonly text: string;
    readonly options?: SubmitPromptOptions;
  }[] = [];

  constructor(private snapshot: UiSnapshot = emptySnapshot()) {}

  emit(event: UiEvent): void {
    for (const handler of this.handlers) {
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

  submitPrompt(
    text: string,
    options?: SubmitPromptOptions,
  ): Promise<void> {
    this.submitted.push({ text, ...(options ? { options } : {}) });
    this.emit(runUpdated("run_1"));
    this.emit(permissionRequested("run_1"));
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

async function withServer<T>(
  backend: FakeBackend,
  callback: (url: string) => Promise<T>,
): Promise<T> {
  const server = createDaemonHttpServer({
    backend,
    host: "127.0.0.1",
    port: 0,
  });
  await server.start();
  try {
    return await callback(server.url);
  } finally {
    await server.stop();
  }
}

async function postRpc(
  url: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${url}/api/rpc`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function createSseReader(response: Response): () => Promise<unknown> {
  const reader = response.body?.getReader() as
    | ReadableStreamDefaultReader<Uint8Array>
    | undefined;
  if (!reader) {
    throw new Error("missing response body");
  }
  const decoder = new TextDecoder();
  let buffer = "";

  return async (): Promise<unknown> => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (!data) {
          throw new Error(`SSE frame missing data: ${frame}`);
        }
        return JSON.parse(data) as unknown;
      }

      const { done, value } = await reader.read();
      if (done) {
        throw new Error("SSE stream ended before an event arrived");
      }
      buffer += decoder.decode(value, { stream: true });
    }
  };
}

describe("createDaemonHttpServer", () => {
  it("serves health checks", async () => {
    await withServer(new FakeBackend(), async (url) => {
      const response = await fetch(`${url}/api/health`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });
  });

  it("dispatches rpc requests to the backend", async () => {
    const snapshot = emptySnapshot();
    await withServer(new FakeBackend(snapshot), async (url) => {
      const response = await postRpc(url, {
        clientId: "client_1",
        id: "rpc_1",
        method: "getSnapshot",
        params: [],
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: "rpc_1",
        ok: true,
        result: snapshot,
      });
    });
  });

  it("returns a structured failure for invalid rpc requests", async () => {
    await withServer(new FakeBackend(), async (url) => {
      const response = await postRpc(url, {
        clientId: "client_1",
        id: "rpc_bad",
        method: "missing",
        params: [],
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        id: "rpc_bad",
        ok: false,
        error: { message: "Unsupported daemon rpc method: missing" },
      });
    });
  });

  it("broadcasts backend events to SSE clients", async () => {
    const backend = new FakeBackend();
    await withServer(backend, async (url) => {
      const first = await fetch(`${url}/api/events?clientId=client_a`);
      const second = await fetch(`${url}/api/events?clientId=client_b`);
      const readFirst = createSseReader(first);
      const readSecond = createSseReader(second);

      await readFirst();
      await readSecond();
      backend.emit(sessionUpdated());

      expect(await readFirst()).toEqual({
        event: sessionUpdated(),
        type: "ui.event",
      });
      expect(await readSecond()).toEqual({
        event: sessionUpdated(),
        type: "ui.event",
      });
    });
  });

  it("routes permission requests only to the prompt owner", async () => {
      const backend = new FakeBackend();
    await withServer(backend, async (url) => {
      const owner = await fetch(`${url}/api/events?clientId=client_a`);
      const observer = await fetch(`${url}/api/events?clientId=client_b`);
      const readOwner = createSseReader(owner);
      const readObserver = createSseReader(observer);
      await readOwner();
      await readObserver();

      const response = await postRpc(url, {
        clientId: "client_a",
        id: "rpc_prompt",
        method: "submitPrompt",
        params: ["hello"],
      });
      expect(response.status).toBe(200);

      expect(await readOwner()).toEqual({
        event: runUpdated("run_1"),
        type: "ui.event",
      });
      expect(await readObserver()).toEqual({
        event: runUpdated("run_1"),
        type: "ui.event",
      });
      expect(await readOwner()).toEqual({
        event: permissionRequested("run_1"),
        type: "ui.event",
      });
      const observerPermission = readObserver().then(
        (event) => ({ event, kind: "event" as const }),
        () => ({ kind: "closed" as const }),
      );
      await expect(
        Promise.race([
          observerPermission,
          new Promise<{ readonly kind: "timeout" }>((resolve) => {
            setTimeout(() => {
              resolve({ kind: "timeout" });
            }, 25);
          }),
        ]),
      ).resolves.toEqual({ kind: "timeout" });
    });
  });

  it("unsubscribes backend events when stopped", async () => {
    const backend = new FakeBackend();
    const server = createDaemonHttpServer({
      backend,
      host: "127.0.0.1",
      port: 0,
    });

    await server.start();
    await fetch(`${server.url}/api/events?clientId=client_a`);
    expect(backend.handlers.size).toBe(1);

    await server.stop();
    expect(backend.handlers.size).toBe(0);
  });
});
