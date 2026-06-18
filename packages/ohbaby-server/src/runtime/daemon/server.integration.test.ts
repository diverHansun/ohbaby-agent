import {
  request as httpRequest,
  createServer as createHttpServer,
} from "node:http";
import { describe, expect, it, vi } from "vitest";
import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiCompactSessionResult,
  UiCompactSessionUsage,
  UiConnectModelResult,
  UiEvent,
  UiEventHandler,
  UiMessage,
  UiSetSearchApiKeyResult,
  UiSnapshot,
  UiUnsubscribe,
} from "ohbaby-sdk";
import {
  createDaemonHttpServer,
  type DaemonHttpServerOptions,
} from "./server.js";
import { daemonAuthHeader } from "../../auth/token.js";

const timestamp = "2026-06-12T00:00:00.000Z";
const authToken = "token_1";

function authHeaders(): Record<string, string> {
  return { authorization: daemonAuthHeader(authToken) };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

function runUpdated(runId: string, sessionId = "session_1"): UiEvent {
  return {
    run: {
      id: runId,
      sessionId,
      startedAt: timestamp,
      status: { kind: "running", runId },
      updatedAt: timestamp,
    },
    type: "run.updated",
  };
}

function messageAppended(sessionId = "session_1"): UiEvent {
  return {
    message: {
      createdAt: timestamp,
      id: `message_${sessionId}`,
      parts: [{ text: `Prompt for ${sessionId}`, type: "text" }],
      role: "user",
    },
    sessionId,
    type: "message.appended",
  };
}

function textMessage(id: string, text: string): UiMessage {
  return {
    createdAt: timestamp,
    id,
    parts: [{ text, type: "text" }],
    role: "user",
  };
}

function sessionWithMessages(
  id: string,
  messages: readonly UiMessage[],
): UiSnapshot["sessions"][number] {
  return {
    createdAt: timestamp,
    id,
    messages,
    title: id,
    updatedAt: timestamp,
  };
}

function snapshotReplaced(activeSessionId: string | null): UiEvent {
  return {
    snapshot: {
      ...emptySnapshot(),
      activeSessionId,
      sessions: [
        {
          createdAt: timestamp,
          id: "session_1",
          messages: [],
          title: "Session 1",
          updatedAt: timestamp,
        },
      ],
    },
    type: "snapshot.replaced",
  };
}

function runtimeRunning(runId: string): UiEvent {
  return {
    status: { kind: "running", runId },
    type: "runtime.updated",
  };
}

function commandResultDelivered(): UiEvent {
  return {
    clientInvocationId: "invoke_1",
    commandRunId: "command_1",
    output: { kind: "text", text: "done" },
    timestamp: Date.parse(timestamp),
    type: "command.result.delivered",
  };
}

function commandSessionSelected(sessionId: string): UiEvent {
  return {
    action: {
      data: { choiceId: sessionId, source: "new" },
      kind: "session.selected",
    },
    clientInvocationId: "invoke_1",
    commandRunId: "command_1",
    timestamp: Date.parse(timestamp),
    type: "command.result.delivered",
  };
}

function permissionRequested(
  runId: string,
): Extract<UiEvent, { type: "permission.requested" }> {
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
  readonly permissionResponses: {
    readonly requestId: string;
    readonly response: Parameters<UiBackendClient["respondPermission"]>[1];
  }[] = [];
  readonly submitted: {
    readonly text: string;
    readonly options?: SubmitPromptOptions;
  }[] = [];
  readonly commandInvocations: Parameters<
    UiBackendClient["executeCommand"]
  >[0][] = [];
  emitOnSubmit = true;
  holdSubmits = false;
  subscribeError: Error | undefined;
  private readonly submitResolvers: (() => void)[] = [];

  constructor(private snapshot: UiSnapshot = emptySnapshot()) {}

  emit(event: UiEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  resolveHeldSubmits(): void {
    for (const resolve of this.submitResolvers.splice(0)) {
      resolve();
    }
  }

  resolveNextSubmit(): void {
    this.submitResolvers.shift()?.();
  }

  getSnapshot(): Promise<UiSnapshot> {
    return Promise.resolve(this.snapshot);
  }

  getContextWindowUsage(): Promise<null> {
    return Promise.resolve(null);
  }

  subscribeEvents(handler: UiEventHandler): UiUnsubscribe {
    if (this.subscribeError) {
      throw this.subscribeError;
    }
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
    if (this.emitOnSubmit) {
      this.emit(runUpdated("run_1", options?.sessionId));
      this.emit(permissionRequested("run_1"));
    }
    if (this.holdSubmits) {
      return new Promise((resolve) => {
        this.submitResolvers.push(resolve);
      });
    }
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

  executeCommand(
    invocation: Parameters<UiBackendClient["executeCommand"]>[0],
  ): Promise<void> {
    this.commandInvocations.push(invocation);
    return Promise.resolve();
  }

  respondPermission(
    requestId: string,
    response: Parameters<UiBackendClient["respondPermission"]>[1],
  ): Promise<void> {
    this.permissionResponses.push({ requestId, response });
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
  options: Partial<
    Omit<DaemonHttpServerOptions, "backend" | "host" | "port">
  > = {},
): Promise<T> {
  const server = createDaemonHttpServer({
    authToken,
    backend,
    host: "127.0.0.1",
    port: 0,
    ...options,
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
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/api/rpc`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...authHeaders(), ...headers },
    method: "POST",
  });
}

function fetchHealth(
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/api/health`, {
    headers: { ...authHeaders(), ...headers },
  });
}

function fetchEvents(
  url: string,
  clientId: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/api/events?clientId=${clientId}`, {
    headers: { ...authHeaders(), ...headers },
  });
}

function postShutdown(
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/api/shutdown`, {
    headers: { ...authHeaders(), ...headers },
    method: "POST",
  });
}

async function postRpcChunks(
  url: string,
  chunks: readonly Buffer[],
): Promise<{ readonly statusCode: number; readonly body: string }> {
  const endpoint = new URL(`${url}/api/rpc`);
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: {
          "content-length": String(
            chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
          ),
          "content-type": "application/json",
          ...authHeaders(),
        },
        hostname: endpoint.hostname,
        method: "POST",
        path: `${endpoint.pathname}${endpoint.search}`,
        port: endpoint.port,
      },
      (response) => {
        const responseChunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          responseChunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            body: Buffer.concat(responseChunks).toString("utf8"),
            statusCode: response.statusCode ?? 0,
          });
        });
      },
    );
    request.on("error", reject);
    for (const chunk of chunks) {
      request.write(chunk);
    }
    request.end();
  });
}

async function reservePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("failed to reserve a port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}

interface SseFrameReader {
  cancel(): Promise<void>;
  read(): Promise<SseFrame>;
}

interface SseFrame {
  readonly data: unknown;
  readonly event?: string;
  readonly id?: string;
}

function createSseFrameReader(response: Response): SseFrameReader {
  const reader = response.body?.getReader() as
    | ReadableStreamDefaultReader<Uint8Array>
    | undefined;
  if (!reader) {
    throw new Error("missing response body");
  }
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    cancel(): Promise<void> {
      return reader.cancel();
    },
    async read(): Promise<{
      readonly data: unknown;
      readonly event?: string;
      readonly id?: string;
    }> {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = frame.split("\n");
          const data = lines
            .find((line) => line.startsWith("data: "))
            ?.slice("data: ".length);
          if (!data) {
            throw new Error(`SSE frame missing data: ${frame}`);
          }
          const event = lines
            .find((line) => line.startsWith("event: "))
            ?.slice("event: ".length);
          const id = lines
            .find((line) => line.startsWith("id: "))
            ?.slice("id: ".length);
          return {
            data: JSON.parse(data) as unknown,
            ...(event === undefined ? {} : { event }),
            ...(id === undefined ? {} : { id }),
          };
        }

        const { done, value } = await reader.read();
        if (done) {
          throw new Error("SSE stream ended before an event arrived");
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

function createSseReader(response: Response): () => Promise<unknown> {
  const frameReader = createSseFrameReader(response);
  return async (): Promise<unknown> => {
    const frame = await frameReader.read();
    return frame.data;
  };
}

function readSseFrameWithTimeout(
  reader: SseFrameReader,
  ms = 100,
): Promise<SseFrame> {
  return Promise.race([
    reader.read(),
    new Promise<SseFrame>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error("Timed out waiting for SSE frame"));
      }, ms);
    }),
  ]);
}

describe("createDaemonHttpServer", () => {
  it("serves health checks", async () => {
    await withServer(new FakeBackend(), async (url) => {
      const response = await fetchHealth(url);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });
  });

  it("includes daemon package version in health checks when configured", async () => {
    await withServer(
      new FakeBackend(),
      async (url) => {
        const response = await fetchHealth(url);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          ok: true,
          packageVersion: "0.1.0",
        });
      },
      { packageVersion: "0.1.0" },
    );
  });

  it("requires daemon auth for rpc and sse when configured", async () => {
    await withServer(
      new FakeBackend(),
      async (url) => {
        const missingRpc = await postRpc(
          url,
          {
            clientId: "client_1",
            id: "rpc_missing_auth",
            method: "getSnapshot",
            params: [],
          },
          { authorization: "" },
        );
        expect(missingRpc.status).toBe(401);

        const missingSse = await fetchEvents(url, "client_a", {
          authorization: "",
        });
        expect(missingSse.status).toBe(401);

        const allowed = await postRpc(
          url,
          {
            clientId: "client_1",
            id: "rpc_allowed",
            method: "getSnapshot",
            params: [],
          },
          { authorization: "Bearer token_1" },
        );
        expect(allowed.status).toBe(200);

        const sse = await fetchEvents(url, "client_a");
        expect(sse.status).toBe(200);
        await sse.body?.cancel();
      },
      { authToken: "token_1" },
    );
  });

  it("requires daemon auth for health checks when configured", async () => {
    await withServer(
      new FakeBackend(),
      async (url) => {
        const rejected = await fetchHealth(url, { authorization: "" });
        expect(rejected.status).toBe(401);

        const allowed = await fetchHealth(url);
        expect(allowed.status).toBe(200);
        expect(await allowed.json()).toEqual({
          ok: true,
          packageVersion: "0.1.0",
        });
      },
      { authToken: "token_1", packageVersion: "0.1.0" },
    );
  });

  it("handles authorized shutdown requests", async () => {
    const onShutdown = vi.fn(() => Promise.resolve());
    await withServer(
      new FakeBackend(),
      async (url) => {
        const rejected = await postShutdown(url, { authorization: "" });
        expect(rejected.status).toBe(401);

        const accepted = await postShutdown(url);
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toEqual({ ok: true });
        await vi.waitUntil(() => onShutdown.mock.calls.length === 1);
        expect(onShutdown).toHaveBeenCalledTimes(1);
      },
      { authToken: "token_1", onShutdown },
    );
  });

  it("responds before stopping itself from shutdown hooks", async () => {
    const backend = new FakeBackend();
    const server = createDaemonHttpServer({
      authToken,
      backend,
      host: "127.0.0.1",
      onShutdown: () => server.stop(),
      port: 0,
    });
    await server.start();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 500);

    try {
      const response = await fetch(`${server.url}/api/shutdown`, {
        headers: authHeaders(),
        method: "POST",
        signal: controller.signal,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      await vi.waitUntil(() => backend.handlers.size === 0);
    } finally {
      clearTimeout(timeout);
      await server.stop();
    }
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

  it("rejects oversized rpc request bodies with payload-too-large", async () => {
    await withServer(new FakeBackend(), async (url) => {
      const body = "x".repeat(1024 * 1024 + 1);
      const response = await fetch(`${url}/api/rpc`, {
        body,
        headers: {
          ...authHeaders(),
          "content-length": String(Buffer.byteLength(body, "utf8")),
          "content-type": "application/json",
        },
        method: "POST",
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { message: "Request body is too large" },
      });
    });
  });

  it("broadcasts backend events to SSE clients", async () => {
    const backend = new FakeBackend();
    await withServer(backend, async (url) => {
      const first = await fetchEvents(url, "client_a");
      const second = await fetchEvents(url, "client_b");
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

  it("replays missed SSE events after Last-Event-ID", async () => {
    const backend = new FakeBackend();
    await withServer(backend, async (url) => {
      const first = await fetchEvents(url, "client_a");
      const readFirst = createSseFrameReader(first);

      await expect(readFirst.read()).resolves.toMatchObject({
        data: { clientId: "client_a", type: "hello" },
      });
      backend.emit(sessionUpdated());
      await expect(readFirst.read()).resolves.toEqual({
        data: {
          event: sessionUpdated(),
          type: "ui.event",
        },
        event: "ui.event",
        id: "1",
      });
      await readFirst.cancel();

      backend.emit(sessionUpdated());
      const resumed = await fetchEvents(url, "client_a", {
        "last-event-id": "1",
      });
      const readResumed = createSseFrameReader(resumed);

      await expect(readResumed.read()).resolves.toMatchObject({
        data: { clientId: "client_a", type: "hello" },
      });
      await expect(readResumed.read()).resolves.toEqual({
        data: {
          event: sessionUpdated(),
          type: "ui.event",
        },
        event: "ui.event",
        id: "2",
      });
      await readResumed.cancel();
    });
  });

  it("replays owner-routed command events after reconnect", async () => {
    const backend = new FakeBackend();
    await withServer(backend, async (url) => {
      const stream = await fetchEvents(url, "client_a");
      const reader = createSseFrameReader(stream);
      await reader.read();

      const invoked = await postRpc(url, {
        clientId: "client_a",
        id: "rpc_command",
        method: "executeCommand",
        params: [
          {
            argv: [],
            clientInvocationId: "invoke_1",
            commandId: "status",
            path: ["status"],
            raw: "/status",
            rawArgs: "",
            surface: "tui",
          },
        ],
      });
      expect(invoked.status).toBe(200);
      await reader.cancel();

      backend.emit(commandResultDelivered());
      const resumed = await fetchEvents(url, "client_a", {
        "last-event-id": "0",
      });
      const resumedReader = createSseFrameReader(resumed);

      await expect(resumedReader.read()).resolves.toMatchObject({
        data: { clientId: "client_a", type: "hello" },
      });
      await expect(resumedReader.read()).resolves.toEqual({
        data: {
          event: commandResultDelivered(),
          type: "ui.event",
        },
        event: "ui.event",
        id: "1",
      });
      await resumedReader.cancel();
    });
  });

  it("replays prompt-owned runtime and permission events after reconnect", async () => {
    const backend = new FakeBackend({
      ...emptySnapshot(),
      sessions: [sessionWithMessages("session_1", [])],
    });
    backend.emitOnSubmit = false;
    backend.holdSubmits = true;
    let submitted: Promise<Response> | undefined;
    await withServer(backend, async (url) => {
      try {
        await postRpc(url, {
          clientId: "client_a",
          id: "rpc_init",
          method: "initializeClient",
          params: [{ resumeSessionId: "session_1" }],
        });
        const stream = await fetchEvents(url, "client_a");
        const reader = createSseFrameReader(stream);
        await reader.read();

        submitted = postRpc(url, {
          clientId: "client_a",
          id: "rpc_prompt",
          method: "submitPrompt",
          params: ["hello", { sessionId: "session_1" }],
        });
        await vi.waitUntil(() => backend.submitted.length === 1);
        await reader.cancel();

        backend.emit(runUpdated("run_1", "session_1"));
        backend.emit(runtimeRunning("run_1"));
        backend.emit(permissionRequested("run_1"));

        const resumed = await fetchEvents(url, "client_a", {
          "last-event-id": "0",
        });
        const resumedReader = createSseFrameReader(resumed);

        await expect(resumedReader.read()).resolves.toMatchObject({
          data: { clientId: "client_a", type: "hello" },
        });
        await expect(resumedReader.read()).resolves.toEqual({
          data: {
            event: runUpdated("run_1", "session_1"),
            type: "ui.event",
          },
          event: "ui.event",
          id: "1",
        });
        await expect(resumedReader.read()).resolves.toEqual({
          data: {
            event: runtimeRunning("run_1"),
            type: "ui.event",
          },
          event: "ui.event",
          id: "2",
        });
        await expect(resumedReader.read()).resolves.toEqual({
          data: {
            event: permissionRequested("run_1"),
            type: "ui.event",
          },
          event: "ui.event",
          id: "3",
        });
        await resumedReader.cancel();
      } finally {
        backend.resolveHeldSubmits();
        await submitted?.catch(() => undefined);
      }
    });
    await expect(submitted).resolves.toMatchObject({ status: 200 });
  });

  it("releases permission ownership after the disconnect replay window", async () => {
    const backend = new FakeBackend();
    await withServer(
      backend,
      async (url) => {
        const stream = await fetchEvents(url, "client_a");
        const reader = createSseFrameReader(stream);
        await reader.read();

        const submit = await postRpc(url, {
          clientId: "client_a",
          id: "rpc_prompt",
          method: "submitPrompt",
          params: ["hello", { sessionId: "session_1" }],
        });
        expect(submit.status).toBe(200);
        await reader.cancel();
        await delay(30);

        const response = await postRpc(url, {
          clientId: "client_b",
          id: "rpc_allow",
          method: "respondPermission",
          params: ["permission_run_1", { choiceId: "allow" }],
        });

        expect(response.status).toBe(200);
      },
      { clientDisconnectRetentionMs: 10 },
    );
  });

  it("signals resync when a client reconnects after routing retention expires", async () => {
    const backend = new FakeBackend();
    await withServer(
      backend,
      async (url) => {
        const stream = await fetchEvents(url, "client_a");
        const reader = createSseFrameReader(stream);
        await reader.read();
        await reader.cancel();
        await delay(30);

        backend.emit(sessionUpdated());
        const resumed = await fetchEvents(url, "client_a", {
          "last-event-id": "0",
        });
        const resumedReader = createSseFrameReader(resumed);

        await expect(resumedReader.read()).resolves.toMatchObject({
          data: { clientId: "client_a", type: "hello" },
        });
        await expect(resumedReader.read()).resolves.toEqual({
          data: {
            maxSeqNum: 1,
            minSeqNum: 1,
            type: "resync-required",
          },
          event: "resync-required",
        });
        await resumedReader.cancel();
      },
      { clientDisconnectRetentionMs: 10 },
    );
  });

  it("signals resync when Last-Event-ID is outside the replay window", async () => {
    const backend = new FakeBackend();
    await withServer(
      backend,
      async (url) => {
        backend.emit(sessionUpdated());
        backend.emit(runUpdated("run_1"));

        const response = await fetchEvents(url, "client_a", {
          "last-event-id": "0",
        });
        const reader = createSseFrameReader(response);

        await expect(reader.read()).resolves.toMatchObject({
          data: { clientId: "client_a", type: "hello" },
        });
        await expect(reader.read()).resolves.toEqual({
          data: {
            maxSeqNum: 2,
            minSeqNum: 2,
            type: "resync-required",
          },
          event: "resync-required",
        });
        await reader.cancel();
      },
      { eventBufferCapacity: 1 },
    );
  });

  it("signals resync when Last-Event-ID is malformed", async () => {
    const backend = new FakeBackend();
    await withServer(backend, async (url) => {
      backend.emit(sessionUpdated());

      const response = await fetchEvents(url, "client_a", {
        "last-event-id": "not-a-number",
      });
      const reader = createSseFrameReader(response);

      await expect(reader.read()).resolves.toMatchObject({
        data: { clientId: "client_a", type: "hello" },
      });
      await expect(readSseFrameWithTimeout(reader)).resolves.toEqual({
        data: {
          maxSeqNum: 1,
          minSeqNum: 1,
          type: "resync-required",
        },
        event: "resync-required",
      });
      await reader.cancel();
    });
  });

  it("routes permission requests only to the prompt owner", async () => {
    const backend = new FakeBackend();
    await withServer(backend, async (url) => {
      const owner = await fetchEvents(url, "client_a");
      const observer = await fetchEvents(url, "client_b");
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

  it("routes overlapping prompt permissions by submitted session", async () => {
    const backend = new FakeBackend();
    backend.emitOnSubmit = false;
    backend.holdSubmits = true;
    await withServer(backend, async (url) => {
      const owner = await fetchEvents(url, "client_a");
      const observer = await fetchEvents(url, "client_b");
      const readOwner = createSseReader(owner);
      const readObserver = createSseReader(observer);
      await readOwner();
      await readObserver();

      const first = postRpc(url, {
        clientId: "client_a",
        id: "rpc_first",
        method: "submitPrompt",
        params: ["first", { sessionId: "session_a" }],
      });
      const second = postRpc(url, {
        clientId: "client_b",
        id: "rpc_second",
        method: "submitPrompt",
        params: ["second", { sessionId: "session_b" }],
      });
      await vi.waitUntil(() => backend.submitted.length === 2);

      backend.emit(runUpdated("run_a", "session_a"));
      backend.emit(permissionRequested("run_a"));

      expect(await readOwner()).toEqual({
        event: runUpdated("run_a", "session_a"),
        type: "ui.event",
      });
      expect(await readObserver()).toEqual({
        event: runUpdated("run_a", "session_a"),
        type: "ui.event",
      });
      expect(await readOwner()).toEqual({
        event: permissionRequested("run_a"),
        type: "ui.event",
      });
      await expect(
        Promise.race([
          readObserver().then(() => "event" as const),
          new Promise<"timeout">((resolve) => {
            setTimeout(() => {
              resolve("timeout");
            }, 25);
          }),
        ]),
      ).resolves.toBe("timeout");

      backend.resolveHeldSubmits();
      await Promise.all([first, second]);
    });
  });

  it("queues same-session prompt submissions across clients", async () => {
    const backend = new FakeBackend();
    backend.holdSubmits = true;
    await withServer(backend, async (url) => {
      const first = postRpc(url, {
        clientId: "client_a",
        id: "rpc_first",
        method: "submitPrompt",
        params: ["first", { sessionId: "session_1" }],
      });
      const second = postRpc(url, {
        clientId: "client_b",
        id: "rpc_second",
        method: "submitPrompt",
        params: ["second", { sessionId: "session_1" }],
      });

      await vi.waitUntil(() => backend.submitted.length >= 1);
      const submittedBeforeRelease = [...backend.submitted];
      if (backend.submitted.length > 1) {
        backend.resolveHeldSubmits();
      }
      expect(submittedBeforeRelease).toEqual([
        { options: { sessionId: "session_1" }, text: "first" },
      ]);

      backend.resolveNextSubmit();
      await expect(first).resolves.toMatchObject({ status: 200 });
      await vi.waitUntil(() => backend.submitted.length === 2);
      expect(backend.submitted[1]).toEqual({
        options: { sessionId: "session_1" },
        text: "second",
      });

      backend.resolveNextSubmit();
      await expect(second).resolves.toMatchObject({ status: 200 });
    });
  });

  it("keeps startup resume intent local to the requesting client", async () => {
    const snapshot = {
      ...emptySnapshot(),
      sessions: [
        {
          createdAt: timestamp,
          id: "session_1",
          messages: [],
          title: "Session 1",
          updatedAt: "2026-06-12T00:00:00.000Z",
        },
        {
          createdAt: timestamp,
          id: "session_2",
          messages: [],
          title: "Session 2",
          updatedAt: "2026-06-12T00:01:00.000Z",
        },
      ],
    } satisfies UiSnapshot;
    const backend = new FakeBackend(snapshot);

    await withServer(backend, async (url) => {
      const initialized = await postRpc(url, {
        clientId: "client_a",
        id: "rpc_init",
        method: "initializeClient",
        params: [{ resumeSessionId: "session_2" }],
      });
      expect(initialized.status).toBe(200);

      const owner = await postRpc(url, {
        clientId: "client_a",
        id: "rpc_owner_snapshot",
        method: "getSnapshot",
        params: [],
      });
      await expect(owner.json()).resolves.toMatchObject({
        id: "rpc_owner_snapshot",
        ok: true,
        result: { activeSessionId: "session_2" },
      });

      const observer = await postRpc(url, {
        clientId: "client_b",
        id: "rpc_observer_snapshot",
        method: "getSnapshot",
        params: [],
      });
      await expect(observer.json()).resolves.toMatchObject({
        id: "rpc_observer_snapshot",
        ok: true,
        result: { activeSessionId: null },
      });

      const submitted = await postRpc(url, {
        clientId: "client_a",
        id: "rpc_prompt",
        method: "submitPrompt",
        params: ["hello"],
      });
      expect(submitted.status).toBe(200);
      expect(backend.submitted).toEqual([
        { options: { sessionId: "session_2" }, text: "hello" },
      ]);
    });
  });

  it("scrubs non-active transcript data from initialized client snapshots", async () => {
    const backend = new FakeBackend({
      ...emptySnapshot(),
      activeSessionId: "session_1",
      contextWindowUsages: [
        {
          contextWindowRatio: 0.1,
          contextWindowTokens: 100,
          currentTokens: 10,
          estimatedAt: timestamp,
          modelId: "model",
          sessionId: "session_1",
        },
      ],
      runs: [
        {
          id: "run_1",
          sessionId: "session_1",
          startedAt: timestamp,
          status: { kind: "running", runId: "run_1" },
          updatedAt: timestamp,
        },
      ],
      sessions: [
        sessionWithMessages("session_1", [
          textMessage("message_secret", "secret transcript"),
        ]),
      ],
      status: { kind: "running", runId: "run_1" },
    });

    await withServer(backend, async (url) => {
      await postRpc(url, {
        clientId: "client_b",
        id: "rpc_init_b",
        method: "initializeClient",
        params: [{ startupSessionMode: { type: "fresh" } }],
      });

      const snapshot = await postRpc(url, {
        clientId: "client_b",
        id: "rpc_snapshot",
        method: "getSnapshot",
        params: [],
      });
      const body = (await snapshot.json()) as { readonly result: UiSnapshot };
      expect(body.result.activeSessionId).toBeNull();
      expect(body.result.sessions).toHaveLength(1);
      expect(body.result.sessions[0]?.messages).toEqual([]);
      expect(body.result.runs).toEqual([]);
      expect(body.result.contextWindowUsages).toEqual([]);
      expect(body.result.status).toEqual({ kind: "idle" });
    });
  });

  it("rewrites snapshot replacement events for each initialized client view", async () => {
    const backend = new FakeBackend({
      ...emptySnapshot(),
      sessions: [
        {
          createdAt: timestamp,
          id: "session_1",
          messages: [],
          title: "Session 1",
          updatedAt: timestamp,
        },
      ],
    });

    await withServer(backend, async (url) => {
      await postRpc(url, {
        clientId: "client_a",
        id: "rpc_init_a",
        method: "initializeClient",
        params: [{ resumeSessionId: "session_1" }],
      });
      await postRpc(url, {
        clientId: "client_b",
        id: "rpc_init_b",
        method: "initializeClient",
        params: [{}],
      });
      const active = await fetchEvents(url, "client_a");
      const fresh = await fetchEvents(url, "client_b");
      const readActive = createSseReader(active);
      const readFresh = createSseReader(fresh);
      await readActive();
      await readFresh();

      backend.emit(snapshotReplaced("session_1"));

      await expect(readActive()).resolves.toMatchObject({
        event: { snapshot: { activeSessionId: "session_1" } },
        type: "ui.event",
      });
      await expect(readFresh()).resolves.toMatchObject({
        event: {
          snapshot: {
            activeSessionId: null,
            runs: [],
            sessions: [{ id: "session_1", messages: [] }],
          },
        },
        type: "ui.event",
      });
    });
  });

  it("returns selected session transcript after selection updates the client view", async () => {
    const targetMessage = textMessage("message_target", "target transcript");
    const backend = new FakeBackend({
      ...emptySnapshot(),
      activeSessionId: "session_1",
      sessions: [
        sessionWithMessages("session_1", [
          textMessage("message_current", "current transcript"),
        ]),
        sessionWithMessages("session_2", [targetMessage]),
      ],
    });

    await withServer(backend, async (url) => {
      await postRpc(url, {
        clientId: "client_a",
        id: "rpc_init_a",
        method: "initializeClient",
        params: [{ resumeSessionId: "session_1" }],
      });
      const events = await fetchEvents(url, "client_a");
      const readEvent = createSseReader(events);
      await readEvent();

      const before = await postRpc(url, {
        clientId: "client_a",
        id: "rpc_before",
        method: "getSnapshot",
        params: [],
      });
      const beforeBody = (await before.json()) as {
        readonly result: UiSnapshot;
      };
      expect(beforeBody.result.activeSessionId).toBe("session_1");
      expect(
        beforeBody.result.sessions.find((session) => session.id === "session_2")
          ?.messages,
      ).toEqual([]);

      await postRpc(url, {
        clientId: "client_a",
        id: "rpc_command",
        method: "executeCommand",
        params: [
          {
            argv: [],
            clientInvocationId: "invoke_sessions",
            commandId: "sessions",
            path: ["sessions"],
            raw: "/sessions",
            rawArgs: "",
            surface: "tui",
          },
        ],
      });
      const selected: UiEvent = {
        action: {
          data: { choiceId: "session_2" },
          kind: "session.selected",
        },
        clientInvocationId: "invoke_sessions",
        commandRunId: "command_sessions",
        timestamp: Date.parse(timestamp),
        type: "command.result.delivered",
      };
      backend.emit(selected);
      await expect(readEvent()).resolves.toEqual({
        event: selected,
        type: "ui.event",
      });

      const after = await postRpc(url, {
        clientId: "client_a",
        id: "rpc_after",
        method: "getSnapshot",
        params: [],
      });
      const afterBody = (await after.json()) as { readonly result: UiSnapshot };
      expect(afterBody.result.activeSessionId).toBe("session_2");
      expect(
        afterBody.result.sessions.find((session) => session.id === "session_2")
          ?.messages,
      ).toEqual([targetMessage]);
      expect(
        afterBody.result.sessions.find((session) => session.id === "session_1")
          ?.messages,
      ).toEqual([]);
    });
  });

  it("keeps other client views unchanged when one client selects a session", async () => {
    const currentMessage = textMessage("message_current", "current transcript");
    const targetMessage = textMessage("message_target", "target transcript");
    const backend = new FakeBackend({
      ...emptySnapshot(),
      activeSessionId: "session_1",
      sessions: [
        sessionWithMessages("session_1", [currentMessage]),
        sessionWithMessages("session_2", [targetMessage]),
      ],
    });

    await withServer(backend, async (url) => {
      await postRpc(url, {
        clientId: "client_a",
        id: "rpc_init_a",
        method: "initializeClient",
        params: [{ resumeSessionId: "session_1" }],
      });
      await postRpc(url, {
        clientId: "client_b",
        id: "rpc_init_b",
        method: "initializeClient",
        params: [{ resumeSessionId: "session_1" }],
      });

      await postRpc(url, {
        clientId: "client_a",
        id: "rpc_command",
        method: "executeCommand",
        params: [
          {
            argv: [],
            clientInvocationId: "invoke_sessions",
            commandId: "sessions",
            path: ["sessions"],
            raw: "/sessions",
            rawArgs: "",
            surface: "tui",
          },
        ],
      });
      backend.emit({
        action: {
          data: { choiceId: "session_2" },
          kind: "session.selected",
        },
        clientInvocationId: "invoke_sessions",
        commandRunId: "command_sessions",
        timestamp: Date.parse(timestamp),
        type: "command.result.delivered",
      });

      const owner = await postRpc(url, {
        clientId: "client_a",
        id: "rpc_owner",
        method: "getSnapshot",
        params: [],
      });
      const ownerBody = (await owner.json()) as { readonly result: UiSnapshot };
      expect(ownerBody.result.activeSessionId).toBe("session_2");
      expect(
        ownerBody.result.sessions.find((session) => session.id === "session_2")
          ?.messages,
      ).toEqual([targetMessage]);
      expect(
        ownerBody.result.sessions.find((session) => session.id === "session_1")
          ?.messages,
      ).toEqual([]);

      const observer = await postRpc(url, {
        clientId: "client_b",
        id: "rpc_observer",
        method: "getSnapshot",
        params: [],
      });
      const observerBody = (await observer.json()) as {
        readonly result: UiSnapshot;
      };
      expect(observerBody.result.activeSessionId).toBe("session_1");
      expect(
        observerBody.result.sessions.find(
          (session) => session.id === "session_1",
        )?.messages,
      ).toEqual([currentMessage]);
      expect(
        observerBody.result.sessions.find(
          (session) => session.id === "session_2",
        )?.messages,
      ).toEqual([]);
    });
  });

  it("filters session updates outside each client view", async () => {
    const backend = new FakeBackend({
      ...emptySnapshot(),
      sessions: [
        sessionWithMessages("session_1", [
          textMessage("message_secret", "secret transcript"),
        ]),
      ],
    });

    await withServer(backend, async (url) => {
      await postRpc(url, {
        clientId: "client_a",
        id: "rpc_init_a",
        method: "initializeClient",
        params: [{ resumeSessionId: "session_1" }],
      });
      await postRpc(url, {
        clientId: "client_b",
        id: "rpc_init_b",
        method: "initializeClient",
        params: [{ startupSessionMode: { type: "fresh" } }],
      });
      const active = await fetchEvents(url, "client_a");
      const fresh = await fetchEvents(url, "client_b");
      const readActive = createSseReader(active);
      const readFresh = createSseReader(fresh);
      await readActive();
      await readFresh();

      const update: UiEvent = {
        session: sessionWithMessages("session_1", [
          textMessage("message_secret", "secret transcript"),
        ]),
        type: "session.updated",
      };
      backend.emit(update);

      await expect(readActive()).resolves.toEqual({
        event: update,
        type: "ui.event",
      });
      await expect(
        Promise.race([
          readFresh().then(() => "event" as const),
          new Promise<"timeout">((resolve) => {
            setTimeout(() => {
              resolve("timeout");
            }, 25);
          }),
        ]),
      ).resolves.toBe("timeout");
    });
  });

  it("does not deliver transcript events to fresh client views", async () => {
    const backend = new FakeBackend({
      ...emptySnapshot(),
      sessions: [
        {
          createdAt: timestamp,
          id: "session_1",
          messages: [],
          title: "Session 1",
          updatedAt: timestamp,
        },
      ],
    });

    await withServer(backend, async (url) => {
      await postRpc(url, {
        clientId: "client_a",
        id: "rpc_init_a",
        method: "initializeClient",
        params: [{ resumeSessionId: "session_1" }],
      });
      await postRpc(url, {
        clientId: "client_b",
        id: "rpc_init_b",
        method: "initializeClient",
        params: [{}],
      });
      const active = await fetchEvents(url, "client_a");
      const fresh = await fetchEvents(url, "client_b");
      const readActive = createSseReader(active);
      const readFresh = createSseReader(fresh);
      await readActive();
      await readFresh();

      backend.emit(messageAppended("session_1"));

      await expect(readActive()).resolves.toEqual({
        event: messageAppended("session_1"),
        type: "ui.event",
      });
      await expect(
        Promise.race([
          readFresh().then(() => "event" as const),
          new Promise<"timeout">((resolve) => {
            setTimeout(() => {
              resolve("timeout");
            }, 25);
          }),
        ]),
      ).resolves.toBe("timeout");
    });
  });

  it("uses an explicit generated session for fresh prompt submits", async () => {
    const backend = new FakeBackend();
    backend.emitOnSubmit = false;
    backend.holdSubmits = true;

    await withServer(
      backend,
      async (url) => {
        await postRpc(url, {
          clientId: "client_a",
          id: "rpc_init_a",
          method: "initializeClient",
          params: [{ startupSessionMode: { type: "fresh" } }],
        });

        const submitted = postRpc(url, {
          clientId: "client_a",
          id: "rpc_prompt",
          method: "submitPrompt",
          params: ["hello"],
        });
        try {
          await vi.waitUntil(() => backend.submitted.length === 1);
          expect(backend.submitted).toEqual([
            {
              options: { sessionId: "session_generated" },
              text: "hello",
            },
          ]);

          backend.emit({
            session: sessionWithMessages("session_other", []),
            type: "session.updated",
          });
          const snapshot = await postRpc(url, {
            clientId: "client_a",
            id: "rpc_snapshot",
            method: "getSnapshot",
            params: [],
          });
          await expect(snapshot.json()).resolves.toMatchObject({
            ok: true,
            result: { activeSessionId: "session_generated" },
          });
        } finally {
          backend.resolveNextSubmit();
        }
        await expect(submitted).resolves.toMatchObject({ status: 200 });
      },
      { createSessionId: () => "session_generated" },
    );
  });

  it("routes runtime updates only to clients that own the run session", async () => {
    const backend = new FakeBackend({
      ...emptySnapshot(),
      sessions: [sessionWithMessages("session_1", [])],
    });

    await withServer(backend, async (url) => {
      await postRpc(url, {
        clientId: "client_a",
        id: "rpc_init_a",
        method: "initializeClient",
        params: [{ resumeSessionId: "session_1" }],
      });
      await postRpc(url, {
        clientId: "client_b",
        id: "rpc_init_b",
        method: "initializeClient",
        params: [{ startupSessionMode: { type: "fresh" } }],
      });
      const active = await fetchEvents(url, "client_a");
      const fresh = await fetchEvents(url, "client_b");
      const readActive = createSseReader(active);
      const readFresh = createSseReader(fresh);
      await readActive();
      await readFresh();

      const run = runUpdated("run_1", "session_1");
      backend.emit(run);
      await expect(readActive()).resolves.toEqual({
        event: run,
        type: "ui.event",
      });

      const runtime = runtimeRunning("run_1");
      backend.emit(runtime);
      await expect(readActive()).resolves.toEqual({
        event: runtime,
        type: "ui.event",
      });
      await expect(
        Promise.race([
          readFresh().then(() => "event" as const),
          new Promise<"timeout">((resolve) => {
            setTimeout(() => {
              resolve("timeout");
            }, 25);
          }),
        ]),
      ).resolves.toBe("timeout");
    });
  });

  it("does not broadcast unowned command results to all clients", async () => {
    const backend = new FakeBackend();

    await withServer(backend, async (url) => {
      const first = await fetchEvents(url, "client_a");
      const second = await fetchEvents(url, "client_b");
      const readFirst = createSseReader(first);
      const readSecond = createSseReader(second);
      await readFirst();
      await readSecond();

      backend.emit(commandResultDelivered());

      const timeout = (): Promise<"timeout"> =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve("timeout");
          }, 25);
        });
      await expect(
        Promise.race([readFirst().then(() => "event" as const), timeout()]),
      ).resolves.toBe("timeout");
      await expect(
        Promise.race([readSecond().then(() => "event" as const), timeout()]),
      ).resolves.toBe("timeout");
    });
  });

  it("routes command results only to the invoking client", async () => {
    const backend = new FakeBackend();

    await withServer(backend, async (url) => {
      const owner = await fetchEvents(url, "client_a");
      const observer = await fetchEvents(url, "client_b");
      const readOwner = createSseReader(owner);
      const readObserver = createSseReader(observer);
      await readOwner();
      await readObserver();

      const invoked = await postRpc(url, {
        clientId: "client_a",
        id: "rpc_command",
        method: "executeCommand",
        params: [
          {
            argv: [],
            clientInvocationId: "invoke_1",
            commandId: "status",
            path: ["status"],
            raw: "/status",
            rawArgs: "",
            surface: "tui",
          },
        ],
      });
      expect(invoked.status).toBe(200);

      backend.emit(commandResultDelivered());

      await expect(readOwner()).resolves.toEqual({
        event: commandResultDelivered(),
        type: "ui.event",
      });
      await expect(
        Promise.race([
          readObserver().then(() => "event" as const),
          new Promise<"timeout">((resolve) => {
            setTimeout(() => {
              resolve("timeout");
            }, 25);
          }),
        ]),
      ).resolves.toBe("timeout");
    });
  });

  it("keeps command ownership across multiple result events", async () => {
    const backend = new FakeBackend({
      ...emptySnapshot(),
      sessions: [
        {
          createdAt: timestamp,
          id: "session_2",
          messages: [],
          title: "Session 2",
          updatedAt: timestamp,
        },
      ],
    });

    await withServer(backend, async (url) => {
      await postRpc(url, {
        clientId: "client_a",
        id: "rpc_init_a",
        method: "initializeClient",
        params: [{ startupSessionMode: { type: "fresh" } }],
      });
      const invoked = await postRpc(url, {
        clientId: "client_a",
        id: "rpc_command",
        method: "executeCommand",
        params: [
          {
            argv: [],
            clientInvocationId: "invoke_1",
            commandId: "new",
            path: ["new"],
            raw: "/new",
            rawArgs: "",
            surface: "tui",
          },
        ],
      });
      expect(invoked.status).toBe(200);

      backend.emit(commandResultDelivered());
      backend.emit(commandSessionSelected("session_2"));

      const snapshot = await postRpc(url, {
        clientId: "client_a",
        id: "rpc_snapshot",
        method: "getSnapshot",
        params: [],
      });
      await expect(snapshot.json()).resolves.toMatchObject({
        id: "rpc_snapshot",
        ok: true,
        result: { activeSessionId: "session_2" },
      });
    });
  });

  it("forces fresh client /new commands to create a separate empty session", async () => {
    const backend = new FakeBackend();

    await withServer(backend, async (url) => {
      await postRpc(url, {
        clientId: "client_a",
        id: "rpc_init_a",
        method: "initializeClient",
        params: [{ startupSessionMode: { type: "fresh" } }],
      });
      const invoked = await postRpc(url, {
        clientId: "client_a",
        id: "rpc_command",
        method: "executeCommand",
        params: [
          {
            argv: [],
            clientInvocationId: "invoke_1",
            commandId: "new",
            path: ["new"],
            raw: "/new",
            rawArgs: "",
            surface: "tui",
          },
        ],
      });
      expect(invoked.status).toBe(200);
      expect(backend.commandInvocations[0]).toMatchObject({
        argv: ["--no-reuse-empty-session"],
        commandId: "new",
        rawArgs: "--no-reuse-empty-session",
      });
    });
  });

  it("rejects permission responses from non-owner clients", async () => {
    const backend = new FakeBackend();
    await withServer(backend, async (url) => {
      const submit = await postRpc(url, {
        clientId: "client_a",
        id: "rpc_prompt",
        method: "submitPrompt",
        params: ["hello", { sessionId: "session_1" }],
      });
      expect(submit.status).toBe(200);

      const rejected = await postRpc(url, {
        clientId: "client_b",
        id: "rpc_reject",
        method: "respondPermission",
        params: ["permission_run_1", { choiceId: "allow" }],
      });
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({
        id: "rpc_reject",
        ok: false,
        error: { message: "Permission request is owned by another client" },
      });

      const allowed = await postRpc(url, {
        clientId: "client_a",
        id: "rpc_allow",
        method: "respondPermission",
        params: ["permission_run_1", { choiceId: "allow" }],
      });
      expect(allowed.status).toBe(200);
      expect(backend.permissionResponses).toEqual([
        {
          requestId: "permission_run_1",
          response: { choiceId: "allow" },
        },
      ]);
    });
  });

  it("preserves UTF-8 request bodies across chunk boundaries", async () => {
    const backend = new FakeBackend();
    await withServer(backend, async (url) => {
      const body = Buffer.from(
        JSON.stringify({
          clientId: "client_a",
          id: "rpc_utf8",
          method: "submitPrompt",
          params: ["你好 daemon", { sessionId: "session_1" }],
        }),
        "utf8",
      );
      const splitAt = body.indexOf(Buffer.from("你", "utf8")) + 1;
      const response = await postRpcChunks(url, [
        body.subarray(0, splitAt),
        body.subarray(splitAt),
      ]);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body) as unknown).toMatchObject({
        id: "rpc_utf8",
        ok: true,
      });
      expect(backend.submitted).toEqual([
        {
          options: { sessionId: "session_1" },
          text: "你好 daemon",
        },
      ]);
    });
  });

  it("unsubscribes backend events when stopped", async () => {
    const backend = new FakeBackend();
    const server = createDaemonHttpServer({
      authToken,
      backend,
      host: "127.0.0.1",
      port: 0,
    });

    await server.start();
    await fetchEvents(server.url, "client_a");
    expect(backend.handlers.size).toBe(1);

    await server.stop();
    expect(backend.handlers.size).toBe(0);
  });

  it("notifies client lifecycle for sse connections", async () => {
    const backend = new FakeBackend();
    const connected: string[] = [];
    const disconnected: string[] = [];
    const server = createDaemonHttpServer({
      authToken,
      backend,
      host: "127.0.0.1",
      onClientConnected: (clientId) => {
        connected.push(clientId);
      },
      onClientDisconnected: (clientId) => {
        disconnected.push(clientId);
      },
      port: 0,
    });

    await server.start();
    try {
      const response = await fetchEvents(server.url, "client_a");
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      await reader?.read();
      await reader?.cancel();

      expect(connected).toEqual(["client_a"]);
      await vi.waitUntil(() => disconnected.length === 1);
      expect(disconnected).toEqual(["client_a"]);
    } finally {
      await server.stop();
    }
  });

  it("closes the listening socket if event subscription fails during start", async () => {
    const port = await reservePort();
    const backend = new FakeBackend();
    backend.subscribeError = new Error("subscribe failed");
    const server = createDaemonHttpServer({
      authToken,
      backend,
      host: "127.0.0.1",
      port,
    });

    await expect(server.start()).rejects.toThrow("subscribe failed");
    await server.stop();

    const nextServer = createDaemonHttpServer({
      authToken,
      backend: new FakeBackend(),
      host: "127.0.0.1",
      port,
    });
    await nextServer.start();
    await nextServer.stop();
  });
});
