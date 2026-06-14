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
import {
  createRemoteUiBackendClient,
  type RemoteDaemonClientOptions,
} from "./client.js";
import {
  createDaemonHttpServer,
  type DaemonHttpServerOptions,
} from "./server.js";

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
  readonly calls: {
    readonly method: string;
    readonly args: readonly unknown[];
  }[] = [];
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
    this.calls.push({ args: [], method: "getSnapshot" });
    return Promise.resolve(this.snapshot);
  }

  getContextWindowUsage(
    input: Parameters<UiBackendClient["getContextWindowUsage"]>[0],
  ): ReturnType<
    UiBackendClient["getContextWindowUsage"]
  > {
    this.calls.push({ args: [input], method: "getContextWindowUsage" });
    return Promise.resolve(null);
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
    this.calls.push({ args: [query], method: "listCommands" });
    return Promise.resolve({ commands: [], version: "v1" });
  }

  submitPrompt(
    text: string,
    options?: SubmitPromptOptions,
  ): Promise<void> {
    if (this.submitError) {
      return Promise.reject(this.submitError);
    }
    this.calls.push({ args: [text, options], method: "submitPrompt" });
    this.submitted.push({ text, ...(options ? { options } : {}) });
    return Promise.resolve();
  }

  compactSession(
    options?: Parameters<UiBackendClient["compactSession"]>[0],
  ): ReturnType<UiBackendClient["compactSession"]> {
    this.calls.push({ args: [options], method: "compactSession" });
    return Promise.resolve(compactResult());
  }

  getCurrentModel(): ReturnType<UiBackendClient["getCurrentModel"]> {
    this.calls.push({ args: [], method: "getCurrentModel" });
    return Promise.resolve(null);
  }

  connectModel(
    input: Parameters<UiBackendClient["connectModel"]>[0],
  ): ReturnType<UiBackendClient["connectModel"]> {
    this.calls.push({ args: [input], method: "connectModel" });
    return Promise.resolve(connectModelResult());
  }

  executeCommand(
    invocation: Parameters<UiBackendClient["executeCommand"]>[0],
  ): Promise<void> {
    this.calls.push({ args: [invocation], method: "executeCommand" });
    return Promise.resolve();
  }

  respondPermission(
    requestId: string,
    response: Parameters<UiBackendClient["respondPermission"]>[1],
  ): Promise<void> {
    this.calls.push({ args: [requestId, response], method: "respondPermission" });
    return Promise.resolve();
  }

  respondInteraction(
    interactionId: string,
    response: Parameters<UiBackendClient["respondInteraction"]>[1],
  ): Promise<void> {
    this.calls.push({
      args: [interactionId, response],
      method: "respondInteraction",
    });
    return Promise.resolve();
  }

  abortRun(runId?: string): Promise<void> {
    this.calls.push({ args: [runId], method: "abortRun" });
    return Promise.resolve();
  }
}

async function withRemoteClient<T>(
  backend: FakeBackend,
  callback: (
    client: ReturnType<typeof createRemoteUiBackendClient>,
  ) => Promise<T>,
  options: {
    readonly client?: Partial<Omit<RemoteDaemonClientOptions, "port">>;
    readonly server?: Partial<
      Omit<DaemonHttpServerOptions, "backend" | "host" | "port">
    >;
  } = {},
): Promise<T> {
  const server = createDaemonHttpServer({
    backend,
    host: "127.0.0.1",
    port: 0,
    ...options.server,
  });
  await server.start();
  const client = createRemoteUiBackendClient({
    clientId: "client_a",
    host: "127.0.0.1",
    port: server.port,
    ...options.client,
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

  it("initializes startup intent before the first rpc", async () => {
    const snapshot = {
      ...emptySnapshot(),
      sessions: [sessionUpdated("session_1").session],
    } satisfies UiSnapshot;
    const backend = new FakeBackend(snapshot);

    await withRemoteClient(
      backend,
      async (client) => {
        await client.submitPrompt("resume target");

        expect(backend.submitted).toEqual([
          {
            options: { sessionId: "session_1" },
            text: "resume target",
          },
        ]);
      },
      {
        client: { startupIntent: { resumeSessionId: "session_1" } },
      },
    );
  });

  it("initializes startup intent before opening the sse stream", async () => {
    const backend = new FakeBackend();
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("/api/rpc") && typeof init?.body === "string") {
        const body = JSON.parse(init.body) as { readonly method?: string };
        requests.push(body.method ?? "unknown-rpc");
      }
      if (url.includes("/api/events")) {
        requests.push("events");
      }
      return fetch(input, init);
    };

    await withRemoteClient(
      backend,
      async (client) => {
        const eventPromise = new Promise<UiEvent>((resolve) => {
          client.subscribeEvents(resolve);
        });

        await eventuallyEmit(backend, sessionUpdated(), eventPromise);
        await eventPromise;

        expect(requests.slice(0, 2)).toEqual(["initializeClient", "events"]);
      },
      {
        client: {
          fetch: fetchImpl,
          startupIntent: {
            initialPermission: { level: "full-access", mode: "plan" },
          },
        },
      },
    );
  });

  it("sends daemon auth tokens for rpc and sse", async () => {
    const backend = new FakeBackend();

    await withRemoteClient(
      backend,
      async (client) => {
        await client.submitPrompt("authenticated", { sessionId: "session_1" });
        const eventPromise = new Promise<UiEvent>((resolve) => {
          client.subscribeEvents(resolve);
        });
        await eventuallyEmit(
          backend,
          sessionUpdated(),
          eventPromise,
        );

        expect(backend.submitted).toEqual([
          {
            options: { sessionId: "session_1" },
            text: "authenticated",
          },
        ]);
        await expect(eventPromise).resolves.toEqual(sessionUpdated());
      },
      {
        client: { authToken: "token_1" },
        server: { authToken: "token_1" },
      },
    );
  });

  it("surfaces daemon auth failures from rpc responses", async () => {
    await withRemoteClient(
      new FakeBackend(),
      async (client) => {
        await expect(client.getSnapshot()).rejects.toThrow("Unauthorized");
      },
      {
        client: { authToken: "wrong_token" },
        server: { authToken: "token_1" },
      },
    );
  });

  it("forwards every CoreAPI method shape through the daemon", async () => {
    const backend = new FakeBackend();
    const listQuery = { surface: "tui" } as const;
    const contextInput = { sessionId: "session_1" };
    const compactOptions = { force: true, sessionId: "session_1" };
    const connectInput = {
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      contextWindowTokens: 100,
      interfaceProvider: "openai-compatible" as const,
      model: "fake-model",
      provider: "fake",
    };
    const invocation = {
      argv: ["now"],
      clientInvocationId: "invoke_1",
      commandId: "time",
      path: ["time"],
      raw: "/time now",
      rawArgs: "now",
      sessionId: "session_1",
      surface: "tui" as const,
    };

    await withRemoteClient(backend, async (client) => {
      await client.getSnapshot();
      await client.getContextWindowUsage(contextInput);
      await client.listCommands(listQuery);
      await client.submitPrompt("hello", { sessionId: "session_1" });
      await client.compactSession(compactOptions);
      await client.getCurrentModel();
      await client.connectModel(connectInput);
      await client.executeCommand(invocation);
      await client.respondPermission("permission_1", { choiceId: "allow" });
      await client.respondInteraction("interaction_1", {
        choiceId: "choice_1",
        kind: "accepted",
      });
      await client.abortRun("run_1");
    });

    expect(backend.calls).toEqual([
      { args: [], method: "getSnapshot" },
      { args: [contextInput], method: "getContextWindowUsage" },
      { args: [listQuery], method: "listCommands" },
      {
        args: ["hello", { sessionId: "session_1" }],
        method: "submitPrompt",
      },
      { args: [compactOptions], method: "compactSession" },
      { args: [], method: "getCurrentModel" },
      { args: [connectInput], method: "connectModel" },
      { args: [invocation], method: "executeCommand" },
      {
        args: ["permission_1", { choiceId: "allow" }],
        method: "respondPermission",
      },
      {
        args: [
          "interaction_1",
          { choiceId: "choice_1", kind: "accepted" },
        ],
        method: "respondInteraction",
      },
      { args: ["run_1"], method: "abortRun" },
    ]);
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

  it("wraps daemon rpc transport failures with method context", async () => {
    const client = createRemoteUiBackendClient({
      fetch: vi.fn<typeof fetch>(() =>
        Promise.reject(new TypeError("fetch failed")),
      ),
      port: 4096,
    });

    await expect(
      client.connectModel({
        apiKeyEnv: "FAKE_API_KEY",
        baseUrl: "https://example.invalid/v1",
        interfaceProvider: "openai-compatible",
        model: "fake-model",
        provider: "fake",
      }),
    ).rejects.toThrow(
      "Daemon connection failed while running connectModel: fetch failed",
    );
  });

  it("reports non-success daemon rpc HTTP responses with non-JSON bodies", async () => {
    const client = createRemoteUiBackendClient({
      fetch: vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response("service unavailable", { status: 503 })),
      ),
      port: 4096,
    });

    await expect(client.getSnapshot()).rejects.toThrow(
      "Daemon request getSnapshot failed with HTTP 503",
    );
  });

  it("keeps SSE connection failures contained until reconnect support exists", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("", { status: 503 })),
    );
    const client = createRemoteUiBackendClient({
      fetch: fetchImpl,
      port: 4096,
    });

    client.subscribeEvents(vi.fn());
    await delay(20);

    await expect(client.dispose()).resolves.toBeUndefined();
  });
});
