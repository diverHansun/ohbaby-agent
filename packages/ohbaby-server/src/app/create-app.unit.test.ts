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
  UiCurrentModelConfig,
  UiEventHandler,
  UiPermissionState,
  UiProbeModelContextWindowResult,
  UiSetSearchApiKeyResult,
  UiSlashCommandCatalog,
  UiSlashCommandInvocation,
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

function sessionUpdated(): Parameters<UiEventHandler>[0] {
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

function compactUsage(): UiCompactSessionUsage {
  return {
    contextLimit: 100,
    currentTokens: 1,
    modelId: "fake-model",
    remainingTokens: 99,
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

function currentModelConfig(): UiCurrentModelConfig {
  return {
    apiKeyEnv: "FAKE_API_KEY",
    baseUrl: "https://example.invalid/v1",
    contextWindowTokens: 100,
    interfaceProvider: "openai-compatible",
    model: "fake-model",
    provider: "fake",
  };
}

function probeModelContextWindowResult(): UiProbeModelContextWindowResult {
  return {
    contextWindowSource: "detected",
    contextWindowTokens: 100,
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
  readonly archivedSessions: string[] = [];
  readonly executedCommands: UiSlashCommandInvocation[] = [];
  readonly compactOptions: Parameters<UiBackendClient["compactSession"]>[0][] =
    [];
  readonly connectedModels: Parameters<UiBackendClient["connectModel"]>[0][] =
    [];
  readonly listCommandQueries: Parameters<
    UiBackendClient["listCommands"]
  >[0][] = [];
  readonly probedModels: Parameters<
    UiBackendClient["probeModelContextWindow"]
  >[0][] = [];
  readonly permissionResponses: {
    readonly requestId: string;
    readonly response: Parameters<UiBackendClient["respondPermission"]>[1];
  }[] = [];
  readonly submitted: {
    readonly text: string;
    readonly options?: SubmitPromptOptions;
  }[] = [];
  readonly searchApiKeys: Parameters<UiBackendClient["setSearchApiKey"]>[0][] =
    [];
  onGetSnapshot: (() => Promise<void> | void) | undefined;
  archiveError: Error | undefined;
  commandCatalog: UiSlashCommandCatalog = {
    commands: [
      {
        argumentMode: "argv",
        category: "system",
        description: "Show backend status",
        id: "status",
        path: ["status"],
        source: "builtin",
        surfaces: ["tui"],
      },
      {
        argumentMode: "argv",
        category: "session",
        description: "Start a new session",
        id: "new",
        path: ["new"],
        source: "builtin",
        surfaces: ["tui"],
      },
    ],
    version: "commands-v1",
  };
  permissionState: UiPermissionState;
  submitError: Error | undefined;

  constructor(private readonly snapshot: UiSnapshot = emptySnapshot()) {
    this.permissionState = snapshot.permission ??
      emptySnapshot().permission ?? {
        level: "default",
        mode: "auto",
        sessionRules: [],
      };
  }

  emit(event: Parameters<UiEventHandler>[0]): void {
    for (const handler of Array.from(this.handlers)) {
      handler(event);
    }
  }

  async getSnapshot(): Promise<UiSnapshot> {
    await this.onGetSnapshot?.();
    return this.snapshot;
  }

  getContextWindowUsage(
    input: Parameters<UiBackendClient["getContextWindowUsage"]>[0],
  ): ReturnType<UiBackendClient["getContextWindowUsage"]> {
    return Promise.resolve({
      contextWindowRatio: 0.01,
      contextWindowTokens: 100,
      currentTokens: 1,
      estimatedAt: timestamp,
      modelId: "fake-model",
      sessionId: input.sessionId,
    });
  }

  subscribeEvents(handler: UiEventHandler): UiUnsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  listCommands(
    query: Parameters<UiBackendClient["listCommands"]>[0],
  ): ReturnType<UiBackendClient["listCommands"]> {
    this.listCommandQueries.push(query);
    return Promise.resolve(this.commandCatalog);
  }

  submitPrompt(text: string, options?: SubmitPromptOptions): Promise<void> {
    this.submitted.push({ text, ...(options ? { options } : {}) });
    if (this.submitError) {
      return Promise.reject(this.submitError);
    }
    return Promise.resolve();
  }

  compactSession(
    options?: Parameters<UiBackendClient["compactSession"]>[0],
  ): ReturnType<UiBackendClient["compactSession"]> {
    this.compactOptions.push(options);
    return Promise.resolve(compactResult());
  }

  getCurrentModel(): ReturnType<UiBackendClient["getCurrentModel"]> {
    return Promise.resolve(currentModelConfig());
  }

  probeModelContextWindow(
    input: Parameters<UiBackendClient["probeModelContextWindow"]>[0],
  ): ReturnType<UiBackendClient["probeModelContextWindow"]> {
    this.probedModels.push(input);
    return Promise.resolve(probeModelContextWindowResult());
  }

  connectModel(
    input: Parameters<UiBackendClient["connectModel"]>[0],
  ): ReturnType<UiBackendClient["connectModel"]> {
    this.connectedModels.push(input);
    return Promise.resolve(connectModelResult());
  }

  setSearchApiKey(
    input: Parameters<UiBackendClient["setSearchApiKey"]>[0],
  ): ReturnType<UiBackendClient["setSearchApiKey"]> {
    this.searchApiKeys.push(input);
    return Promise.resolve(setSearchApiKeyResult());
  }

  setPermission(
    input: Parameters<UiBackendClient["setPermission"]>[0],
  ): ReturnType<UiBackendClient["setPermission"]> {
    this.permissionState = {
      ...this.permissionState,
      ...input,
    };
    this.emit({
      permission: this.permissionState,
      type: "permission.updated",
    });
    return Promise.resolve(this.permissionState);
  }

  executeCommand(invocation: UiSlashCommandInvocation): Promise<void> {
    this.executedCommands.push(invocation);
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

  archiveSession(input: { readonly sessionId: string }): Promise<void> {
    if (this.archiveError) {
      return Promise.reject(this.archiveError);
    }
    this.archivedSessions.push(input.sessionId);
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

async function readNextSseData(input: {
  readonly buffer: { value: string };
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
}): Promise<unknown> {
  const decoder = new TextDecoder();
  for (;;) {
    const boundary = input.buffer.value.indexOf("\n\n");
    if (boundary >= 0) {
      const frame = input.buffer.value.slice(0, boundary);
      input.buffer.value = input.buffer.value.slice(boundary + 2);
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length);
      if (!data) {
        throw new Error(`SSE frame missing data: ${frame}`);
      }
      return JSON.parse(data) as unknown;
    }
    const chunk = await input.reader.read();
    if (chunk.done) {
      throw new Error("SSE stream ended before an event arrived");
    }
    input.buffer.value += decoder.decode(chunk.value, { stream: true });
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
          "/v1/commands",
          "/v1/events",
          "/v1/prompts",
          "/v1/sessions",
          "/v1/sessions/{id}/select",
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

  it("rejects unregistered web clients before exposing a snapshot", async () => {
    const handle = createApp();
    await handle.start();
    try {
      const response = await handle.app.request("/v1/snapshot", {
        headers: {
          ...authHeaders(),
          "x-ohbaby-client-id": "client_unknown",
        },
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: { message: "client is not registered" },
        ok: false,
      });
    } finally {
      await handle.dispose();
    }
  });

  it("uses the post-snapshot event sequence as the web snapshot baseline", async () => {
    const backend = new FakeBackend(emptySnapshot());
    let getSnapshotCalls = 0;
    backend.onGetSnapshot = (): void => {
      getSnapshotCalls += 1;
      if (getSnapshotCalls === 2) {
        backend.emit(sessionUpdated());
      }
    };
    const handle = createApp(backend);
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
      const response = await handle.app.request("/v1/snapshot", {
        headers: {
          ...authHeaders(),
          "x-ohbaby-client-id": "client_web",
        },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        seqNum: 1,
      });
    } finally {
      await handle.dispose();
    }
  });

  it("updates daemon permission state for registered web clients", async () => {
    const backend = new FakeBackend();
    const handle = createApp(backend);
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
      const response = await handle.app.request("/v1/permission", {
        body: JSON.stringify({ level: "full-access", mode: "plan" }),
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "x-ohbaby-client-id": "client_web",
        },
        method: "PATCH",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        permission: {
          level: "full-access",
          mode: "plan",
          sessionRules: [],
        },
      });
    } finally {
      await handle.dispose();
    }
  });

  it("lists slash commands for registered web clients", async () => {
    const backend = new FakeBackend();
    backend.commandCatalog = {
      commands: [
        {
          argumentMode: "argv",
          category: "system",
          description: "Show backend status",
          id: "status",
          path: ["status"],
          source: "builtin",
          surfaces: ["tui"],
        },
        {
          argumentMode: "argv",
          category: "session",
          description: "Browse sessions",
          id: "sessions",
          parentBehavior: "interaction",
          path: ["sessions"],
          source: "builtin",
          surfaces: ["tui"],
        },
        {
          argumentMode: "argv",
          category: "session",
          description: "Compact the current session",
          id: "compact",
          path: ["compact"],
          source: "builtin",
          surfaces: ["tui"],
        },
      ],
      version: "commands-v1",
    };
    const handle = createApp(backend);
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
      const response = await handle.app.request("/v1/commands?surface=tui", {
        headers: {
          ...authHeaders(),
          "x-ohbaby-client-id": "client_web",
        },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        catalog: {
          commands: [{ id: "status" }],
          version: "commands-v1",
        },
        ok: true,
      });
      expect(backend.listCommandQueries).toEqual([{ surface: "tui" }]);
    } finally {
      await handle.dispose();
    }
  });

  it("lists web palette commands with structured overlays for registered web clients", async () => {
    const backend = new FakeBackend();
    backend.commandCatalog = {
      commands: [
        {
          argumentMode: "argv",
          category: "system",
          description: "Show backend status",
          id: "status",
          path: ["status"],
          source: "builtin",
          surfaces: ["tui"],
        },
        {
          argumentMode: "structured",
          category: "setup",
          description: "Connect model",
          id: "connect",
          parentBehavior: "interaction",
          path: ["connect"],
          source: "builtin",
          surfaces: ["tui"],
        },
        {
          argumentMode: "structured",
          category: "setup",
          description: "Connect search",
          id: "connect-search",
          parentBehavior: "interaction",
          path: ["connect-search"],
          source: "builtin",
          surfaces: ["tui"],
        },
        {
          argumentMode: "argv",
          category: "session",
          description: "Compact the current session",
          id: "compact",
          path: ["compact"],
          source: "builtin",
          surfaces: ["tui"],
        },
        {
          argumentMode: "argv",
          category: "session",
          description: "Browse sessions",
          id: "sessions",
          parentBehavior: "interaction",
          path: ["sessions"],
          source: "builtin",
          surfaces: ["tui"],
        },
      ],
      version: "commands-v1",
    };
    const handle = createApp(backend);
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
      const response = await handle.app.request("/v1/commands?surface=web", {
        headers: {
          ...authHeaders(),
          "x-ohbaby-client-id": "client_web",
        },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        catalog: {
          commands: [
            {
              action: "executeCommand",
              executionKind: "passthrough",
              id: "status",
            },
            {
              action: "connectModel",
              executionKind: "overlay",
              id: "connect",
            },
            {
              action: "connectSearch",
              executionKind: "overlay",
              id: "connect-search",
            },
            {
              action: "compactSession",
              executionKind: "overlay",
              id: "compact",
            },
          ],
          version: "commands-v1",
        },
        ok: true,
      });
      expect(backend.listCommandQueries).toEqual([{ surface: "tui" }]);
    } finally {
      await handle.dispose();
    }
  });

  it.each([
    {
      method: "GET" as const,
      path: "/v1/commands?surface=tui",
    },
    {
      body: {
        argv: [],
        clientInvocationId: "invoke_status",
        commandId: "status",
        path: ["status"],
        raw: "/status",
        rawArgs: "",
        surface: "tui",
      },
      method: "POST" as const,
      path: "/v1/commands",
    },
  ])(
    "rejects unauthenticated $method command requests",
    async ({ body, method, path }) => {
      const handle = createApp();
      await handle.start();
      try {
        const response = await handle.app.request(path, {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers:
            body === undefined
              ? undefined
              : { "content-type": "application/json" },
          method,
        });

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
          error: { message: "Unauthorized" },
          ok: false,
        });
      } finally {
        await handle.dispose();
      }
    },
  );

  it.each([
    {
      method: "GET" as const,
      path: "/v1/commands?surface=tui",
    },
    {
      body: {
        argv: [],
        clientInvocationId: "invoke_status",
        commandId: "status",
        path: ["status"],
        raw: "/status",
        rawArgs: "",
        surface: "tui",
      },
      method: "POST" as const,
      path: "/v1/commands",
    },
  ])(
    "requires a client id for $method command requests",
    async ({ body, method, path }) => {
      const handle = createApp();
      await handle.start();
      try {
        const response = await handle.app.request(path, {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers: {
            ...authHeaders(),
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          method,
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: { message: "clientId is required" },
          ok: false,
        });
      } finally {
        await handle.dispose();
      }
    },
  );

  it.each([
    {
      method: "GET" as const,
      path: "/v1/commands?surface=tui",
    },
    {
      body: {
        argv: [],
        clientInvocationId: "invoke_status",
        commandId: "status",
        path: ["status"],
        raw: "/status",
        rawArgs: "",
        surface: "tui",
      },
      method: "POST" as const,
      path: "/v1/commands",
    },
  ])(
    "rejects unregistered web clients for $method command requests",
    async ({ body, method, path }) => {
      const handle = createApp();
      await handle.start();
      try {
        const response = await handle.app.request(path, {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers: {
            ...authHeaders(),
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
            "x-ohbaby-client-id": "client_unknown",
          },
          method,
        });

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
          error: { message: "client is not registered" },
          ok: false,
        });
      } finally {
        await handle.dispose();
      }
    },
  );

  it("executes slash commands through the client view coordinator", async () => {
    const backend = new FakeBackend();
    const handle = createApp(backend);
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
      const response = await handle.app.request("/v1/commands", {
        body: JSON.stringify({
          argv: [],
          clientInvocationId: "invoke_status",
          commandId: "status",
          path: ["status"],
          raw: "/status",
          rawArgs: "",
          surface: "tui",
        }),
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "x-ohbaby-client-id": "client_web",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(backend.executedCommands).toEqual([
        {
          argv: [],
          clientInvocationId: "invoke_status",
          commandId: "status",
          path: ["status"],
          raw: "/status",
          rawArgs: "",
          surface: "tui",
        },
      ]);
    } finally {
      await handle.dispose();
    }
  });

  it("rejects /new through the web slash command passthrough route", async () => {
    const backend = new FakeBackend();
    const handle = createApp(backend);
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
      const response = await handle.app.request("/v1/commands", {
        body: JSON.stringify({
          argv: [],
          clientInvocationId: "invoke_new",
          commandId: "new",
          path: ["new"],
          raw: "/new",
          rawArgs: "",
          surface: "tui",
        }),
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "x-ohbaby-client-id": "client_web",
        },
        method: "POST",
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { message: "command is not supported by web passthrough" },
        ok: false,
      });
      expect(backend.executedCommands).toEqual([]);
    } finally {
      await handle.dispose();
    }
  });

  it("creates sessions for registered web clients through a dedicated REST route", async () => {
    const backend = new FakeBackend();
    const handle = createApp(backend);
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
      const response = await handle.app.request("/v1/sessions", {
        headers: {
          ...authHeaders(),
          "x-ohbaby-client-id": "client_web",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(backend.executedCommands[0]?.clientInvocationId).toMatch(
        /^web_session_/,
      );
      expect(backend.executedCommands).toEqual([
        {
          argumentMode: "argv",
          argv: ["--no-reuse-empty-session"],
          clientInvocationId: backend.executedCommands[0]?.clientInvocationId,
          commandId: "new",
          path: ["new"],
          raw: "/new --no-reuse-empty-session",
          rawArgs: "--no-reuse-empty-session",
          surface: "tui",
        },
      ]);
    } finally {
      await handle.dispose();
    }
  });

  it("allows repeated web session creation to reuse the active empty session", async () => {
    const backend = new FakeBackend();
    const handle = createApp(backend);
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
      const first = await handle.app.request("/v1/sessions", {
        headers: {
          ...authHeaders(),
          "x-ohbaby-client-id": "client_web",
        },
        method: "POST",
      });
      expect(first.status).toBe(200);
      const firstInvocation = backend.executedCommands[0];
      expect(firstInvocation).toMatchObject({
        argv: ["--no-reuse-empty-session"],
        commandId: "new",
        rawArgs: "--no-reuse-empty-session",
      });

      backend.emit({
        action: {
          data: { choiceId: "session_web_1" },
          kind: "session.selected",
        },
        clientInvocationId: firstInvocation.clientInvocationId,
        commandRunId: "command_new_1",
        timestamp: Date.parse(timestamp),
        type: "command.result.delivered",
      });

      const second = await handle.app.request("/v1/sessions", {
        headers: {
          ...authHeaders(),
          "x-ohbaby-client-id": "client_web",
        },
        method: "POST",
      });

      expect(second.status).toBe(200);
      expect(backend.executedCommands[1]).toMatchObject({
        argv: [],
        commandId: "new",
        raw: "/new",
        rawArgs: "",
      });
    } finally {
      await handle.dispose();
    }
  });

  it("selects sessions for registered web clients through a dedicated REST route", async () => {
    const backend = new FakeBackend();
    const handle = createApp(backend);
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
      const response = await handle.app.request(
        "/v1/sessions/session_2/select",
        {
          headers: {
            ...authHeaders(),
            "x-ohbaby-client-id": "client_web",
          },
          method: "PATCH",
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(backend.executedCommands[0]?.clientInvocationId).toMatch(
        /^web_session_/,
      );
      expect(backend.executedCommands).toEqual([
        {
          argumentMode: "argv",
          argv: ["--session_id", "session_2"],
          clientInvocationId: backend.executedCommands[0]?.clientInvocationId,
          commandId: "resume",
          path: ["resume"],
          raw: "/resume --session_id session_2",
          rawArgs: "--session_id session_2",
          surface: "tui",
        },
      ]);
    } finally {
      await handle.dispose();
    }
  });

  it("archives sessions for registered web clients through a dedicated REST route", async () => {
    const backend = new FakeBackend();
    const handle = createApp(backend);
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
      const response = await handle.app.request(
        "/v1/sessions/session_2/archive",
        {
          headers: {
            ...authHeaders(),
            "x-ohbaby-client-id": "client_web",
          },
          method: "PATCH",
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(backend.archivedSessions).toEqual(["session_2"]);
    } finally {
      await handle.dispose();
    }
  });

  it("returns not found when the archive route targets a missing session", async () => {
    const backend = new FakeBackend();
    backend.archiveError = new Error("Session not found: session_missing");
    const handle = createApp(backend);
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
      const response = await handle.app.request(
        "/v1/sessions/session_missing/archive",
        {
          headers: {
            ...authHeaders(),
            "x-ohbaby-client-id": "client_web",
          },
          method: "PATCH",
        },
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: { message: "Session not found: session_missing" },
        ok: false,
      });
      expect(backend.archivedSessions).toEqual([]);
    } finally {
      await handle.dispose();
    }
  });

  it("returns bad request when the archive route rejects the session", async () => {
    const backend = new FakeBackend();
    backend.archiveError = new Error("Cannot archive subagent session: child_1");
    const handle = createApp(backend);
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
      const response = await handle.app.request(
        "/v1/sessions/child_1/archive",
        {
          headers: {
            ...authHeaders(),
            "x-ohbaby-client-id": "client_web",
          },
          method: "PATCH",
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { message: "Cannot archive subagent session: child_1" },
        ok: false,
      });
      expect(backend.archivedSessions).toEqual([]);
    } finally {
      await handle.dispose();
    }
  });

  it.each([
    { method: "POST" as const, path: "/v1/sessions" },
    { method: "PATCH" as const, path: "/v1/sessions/session_2/select" },
    { method: "PATCH" as const, path: "/v1/sessions/session_2/archive" },
  ])(
    "rejects unauthenticated $method session route requests",
    async (input) => {
      const handle = createApp();
      await handle.start();
      try {
        const response = await handle.app.request(input.path, {
          method: input.method,
        });

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
          error: { message: "Unauthorized" },
          ok: false,
        });
      } finally {
        await handle.dispose();
      }
    },
  );

  it.each([
    { method: "POST" as const, path: "/v1/sessions" },
    { method: "PATCH" as const, path: "/v1/sessions/session_2/select" },
    { method: "PATCH" as const, path: "/v1/sessions/session_2/archive" },
  ])(
    "requires a client id for $method session route requests",
    async (input) => {
      const handle = createApp();
      await handle.start();
      try {
        const response = await handle.app.request(input.path, {
          headers: authHeaders(),
          method: input.method,
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: { message: "clientId is required" },
          ok: false,
        });
      } finally {
        await handle.dispose();
      }
    },
  );

  it.each([
    { method: "POST" as const, path: "/v1/sessions" },
    { method: "PATCH" as const, path: "/v1/sessions/session_2/select" },
    { method: "PATCH" as const, path: "/v1/sessions/session_2/archive" },
  ])(
    "rejects unregistered web clients for $method session route requests",
    async (input) => {
      const handle = createApp();
      await handle.start();
      try {
        const response = await handle.app.request(input.path, {
          headers: {
            ...authHeaders(),
            "x-ohbaby-client-id": "client_unknown",
          },
          method: input.method,
        });

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
          error: { message: "client is not registered" },
          ok: false,
        });
      } finally {
        await handle.dispose();
      }
    },
  );

  it("rejects invalid slash command invocations", async () => {
    const handle = createApp();
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

      const response = await handle.app.request("/v1/commands", {
        body: JSON.stringify({ commandId: "status" }),
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "x-ohbaby-client-id": "client_web",
        },
        method: "POST",
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { message: "command invocation is invalid" },
        ok: false,
      });
    } finally {
      await handle.dispose();
    }
  });

  it("rejects unsupported web slash commands before execution", async () => {
    const backend = new FakeBackend();
    backend.commandCatalog = {
      commands: [
        {
          argumentMode: "argv",
          category: "session",
          description: "Browse sessions",
          id: "sessions",
          parentBehavior: "interaction",
          path: ["sessions"],
          source: "builtin",
          surfaces: ["tui"],
        },
      ],
      version: "commands-v1",
    };
    const handle = createApp(backend);
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
      const response = await handle.app.request("/v1/commands", {
        body: JSON.stringify({
          argv: [],
          clientInvocationId: "invoke_sessions",
          commandId: "sessions",
          path: ["sessions"],
          raw: "/sessions",
          rawArgs: "",
          surface: "tui",
        }),
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "x-ohbaby-client-id": "client_web",
        },
        method: "POST",
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { message: "command is not supported by web passthrough" },
        ok: false,
      });
      expect(backend.executedCommands).toEqual([]);
    } finally {
      await handle.dispose();
    }
  });

  it("rejects spoofed web-safe slash command ids before execution", async () => {
    const backend = new FakeBackend();
    backend.commandCatalog = {
      commands: [
        {
          argumentMode: "argv",
          category: "system",
          description: "Spoofed status",
          id: "status",
          path: ["status"],
          source: "plugin",
          surfaces: ["tui"],
        },
      ],
      version: "commands-v1",
    };
    const handle = createApp(backend);
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
      const response = await handle.app.request("/v1/commands", {
        body: JSON.stringify({
          argv: [],
          clientInvocationId: "invoke_status",
          commandId: "status",
          path: ["status"],
          raw: "/status",
          rawArgs: "",
          surface: "tui",
        }),
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          "x-ohbaby-client-id": "client_web",
        },
        method: "POST",
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { message: "command is not supported by web passthrough" },
        ok: false,
      });
      expect(backend.executedCommands).toEqual([]);
    } finally {
      await handle.dispose();
    }
  });

  it.each([
    {
      commandId: "connect",
      path: ["connect"],
      raw: "/connect",
    },
    {
      commandId: "connect-search",
      path: ["connect-search"],
      raw: "/connect-search",
    },
    {
      commandId: "compact",
      path: ["compact"],
      raw: "/compact",
    },
  ])(
    "rejects overlay slash command $raw through raw passthrough",
    async (input) => {
      const backend = new FakeBackend();
      backend.commandCatalog = {
        commands: [
          {
            argumentMode: "argv",
            category: "session",
            description: "Compact the current session",
            id: "compact",
            path: ["compact"],
            source: "builtin",
            surfaces: ["tui"],
          },
          {
            argumentMode: "structured",
            category: "setup",
            description: "Connect model",
            id: "connect",
            parentBehavior: "interaction",
            path: ["connect"],
            source: "builtin",
            surfaces: ["tui"],
          },
          {
            argumentMode: "structured",
            category: "setup",
            description: "Connect search",
            id: "connect-search",
            parentBehavior: "interaction",
            path: ["connect-search"],
            source: "builtin",
            surfaces: ["tui"],
          },
        ],
        version: "commands-v1",
      };
      const handle = createApp(backend);
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
        const response = await handle.app.request("/v1/commands", {
          body: JSON.stringify({
            argumentMode: "argv",
            argv: [],
            clientInvocationId: `invoke_${input.commandId}`,
            commandId: input.commandId,
            path: input.path,
            raw: input.raw,
            rawArgs: "",
            surface: "tui",
          }),
          headers: {
            ...authHeaders(),
            "content-type": "application/json",
            "x-ohbaby-client-id": "client_web",
          },
          method: "POST",
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: { message: "command is not supported by web passthrough" },
          ok: false,
        });
        expect(backend.executedCommands).toEqual([]);
      } finally {
        await handle.dispose();
      }
    },
  );

  it.each([
    {
      body: {
        apiKeyEnv: "ANTHROPIC_API_KEY",
        baseUrl: "https://api.anthropic.com",
        contextWindowTokens: 0,
        model: "claude-sonnet-4.6",
        provider: "anthropic",
      },
      path: "/v1/model/context-window-probe",
    },
    {
      body: {
        apiKeyEnv: "ZHIPU_API_KEY",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        maxOutputTokens: -1,
        model: "glm-4.7",
        provider: "zhipu",
      },
      path: "/v1/model",
    },
  ])(
    "rejects invalid structured model token fields for $path",
    async ({ body, path }) => {
      const backend = new FakeBackend();
      const handle = createApp(backend);
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
        const response = await handle.app.request(path, {
          body: JSON.stringify(body),
          headers: {
            ...authHeaders(),
            "content-type": "application/json",
            "x-ohbaby-client-id": "client_web",
          },
          method: "POST",
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
          error: { message: "model connection body is invalid" },
          ok: false,
        });
        expect(backend.connectedModels).toEqual([]);
        expect(backend.probedModels).toEqual([]);
      } finally {
        await handle.dispose();
      }
    },
  );

  it("serves structured model, search, and compact REST routes", async () => {
    const backend = new FakeBackend();
    const handle = createApp(backend);
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
      const clientHeaders = {
        ...authHeaders(),
        "content-type": "application/json",
        "x-ohbaby-client-id": "client_web",
      };

      const modelResponse = await handle.app.request("/v1/model", {
        headers: clientHeaders,
      });
      expect(modelResponse.status).toBe(200);
      await expect(modelResponse.json()).resolves.toEqual({
        model: currentModelConfig(),
        ok: true,
      });

      const probeResponse = await handle.app.request(
        "/v1/model/context-window-probe",
        {
          body: JSON.stringify({
            apiKeyEnv: "ANTHROPIC_API_KEY",
            baseUrl: "https://api.anthropic.com",
            contextWindowTokens: 96_000,
            model: "claude-sonnet-4.6",
            provider: "anthropic",
          }),
          headers: clientHeaders,
          method: "POST",
        },
      );
      expect(probeResponse.status).toBe(200);
      await expect(probeResponse.json()).resolves.toEqual({
        ok: true,
        probe: probeModelContextWindowResult(),
      });
      expect(backend.probedModels).toEqual([
        {
          apiKeyEnv: "ANTHROPIC_API_KEY",
          baseUrl: "https://api.anthropic.com",
          contextWindowTokens: 96_000,
          interfaceProvider: "anthropic",
          model: "claude-sonnet-4.6",
          provider: "anthropic",
        },
      ]);

      const connectResponse = await handle.app.request("/v1/model", {
        body: JSON.stringify({
          apiKey: "sk-secret",
          apiKeyEnv: "ZHIPU_API_KEY",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
          model: "glm-4.7",
          provider: "zhipu",
        }),
        headers: clientHeaders,
        method: "POST",
      });
      expect(connectResponse.status).toBe(200);
      const connectBody = await connectResponse.json();
      expect(connectBody).toEqual({
        model: connectModelResult(),
        ok: true,
      });
      expect(JSON.stringify(connectBody)).not.toContain("sk-secret");
      expect(backend.connectedModels).toEqual([
        {
          apiKey: "sk-secret",
          apiKeyEnv: "ZHIPU_API_KEY",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
          interfaceProvider: "openai-compatible",
          model: "glm-4.7",
          provider: "zhipu",
        },
      ]);

      const searchResponse = await handle.app.request(
        "/v1/settings/search-api-key",
        {
          body: JSON.stringify({
            apiKey: "tvly-secret",
            apiKeyEnv: "TAVILY_API_KEY",
            provider: "tavily",
          }),
          headers: clientHeaders,
          method: "POST",
        },
      );
      expect(searchResponse.status).toBe(200);
      const searchBody = await searchResponse.json();
      expect(searchBody).toEqual({
        ok: true,
        search: setSearchApiKeyResult(),
      });
      expect(JSON.stringify(searchBody)).not.toContain("tvly-secret");
      expect(backend.searchApiKeys).toEqual([
        {
          apiKey: "tvly-secret",
          apiKeyEnv: "TAVILY_API_KEY",
          provider: "tavily",
        },
      ]);

      const usageResponse = await handle.app.request(
        "/v1/sessions/session_1/context-window",
        {
          headers: clientHeaders,
        },
      );
      expect(usageResponse.status).toBe(200);
      await expect(usageResponse.json()).resolves.toMatchObject({
        ok: true,
        usage: {
          contextWindowTokens: 100,
          currentTokens: 1,
          sessionId: "session_1",
        },
      });

      const compactResponse = await handle.app.request(
        "/v1/sessions/session_1/compact",
        {
          body: JSON.stringify({ force: true }),
          headers: clientHeaders,
          method: "POST",
        },
      );
      expect(compactResponse.status).toBe(200);
      await expect(compactResponse.json()).resolves.toEqual({
        compact: compactResult(),
        ok: true,
      });
      expect(backend.compactOptions).toEqual([
        { force: true, sessionId: "session_1" },
      ]);
    } finally {
      await handle.dispose();
    }
  });

  it("serves the web SSE hello event", async () => {
    const handle = createApp();
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

  it("surfaces asynchronous web prompt failures to the client event stream", async () => {
    const backend = new FakeBackend();
    backend.submitError = new Error("submit failed");
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
      const eventsResponse = await handle.app.request("/v1/events", {
        headers: {
          ...authHeaders(),
          "x-ohbaby-client-id": "client_web",
        },
      });
      const reader = eventsResponse.body?.getReader();
      if (!reader) {
        throw new Error("missing event stream");
      }
      const buffer = { value: "" };
      await expect(readNextSseData({ buffer, reader })).resolves.toEqual({
        clientId: "client_web",
        type: "hello",
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
      await expect(readNextSseData({ buffer, reader })).resolves.toEqual({
        message: "submit failed",
        type: "error",
      });
      await reader.cancel();
    } finally {
      await handle.dispose();
    }
  });

  it("does not abort a session when no run belongs to it", async () => {
    const backend = new FakeBackend();
    const handle = createApp(backend);
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
      const response = await handle.app.request(
        "/v1/sessions/session_1/abort",
        {
          body: JSON.stringify({}),
          headers: {
            ...authHeaders(),
            "content-type": "application/json",
            "x-ohbaby-client-id": "client_web",
          },
          method: "POST",
        },
      );

      expect(response.status).toBe(404);
      expect(backend.abortedRunIds).toEqual([]);
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

  it("refuses to inject web bootstrap tokens when disabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-web-assets-"));
    await writeFile(
      join(tempDir, "index.html"),
      "<!doctype html><html><head></head><body></body></html>",
      "utf8",
    );
    const handle = createApp(new FakeBackend(), {
      webAssets: { allowTokenInjection: false, directory: tempDir },
    });
    await handle.start();
    try {
      const response = await handle.app.request("/", {
        headers: { accept: "text/html" },
      });

      expect(response.status).toBe(403);
    } finally {
      await handle.dispose();
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
