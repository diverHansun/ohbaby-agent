import { describe, expect, it, vi } from "vitest";
import { createRPC, type CoreAPI, type UiCommandRecord } from "ohbaby-sdk";

describe("buildCoreAPIImpl", () => {
  it("builds CoreAPI and callback adapters from the persistent backend", async () => {
    vi.resetModules();
    const unsubscribe = vi.fn();
    const submitPromptAccepted = vi.fn(() =>
      Promise.resolve({
        clientRequestId: "request_1",
        createdAt: "2026-08-14T00:00:00.000Z",
        promptId: "prompt_1",
        sessionId: "session_1",
        status: "queued" as const,
        userMessageId: "message_1",
      }),
    );
    const waitForPrompt = vi.fn(
      (_promptId: string, options?: { readonly signal?: AbortSignal }) => {
        if (options?.signal) {
          return new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("backend waiter aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          });
        }
        return Promise.resolve({
          prompt: {
            clientRequestId: "request_1",
            createdAt: "2026-08-14T00:00:00.000Z",
            endedAt: "2026-08-14T00:00:01.000Z",
            promptId: "prompt_1",
            scopeKey: "/workspace",
            sessionId: "session_1",
            status: "succeeded" as const,
            text: "hello",
            updatedAt: "2026-08-14T00:00:01.000Z",
            userMessageId: "message_1",
          },
        });
      },
    );
    const records: UiCommandRecord[] = [];
    const getCurrentModel = vi.fn(() => Promise.resolve(null));
    const connectModel = vi.fn(() =>
      Promise.resolve({
        apiKeyEnv: "ZENMUX_API_KEY",
        baseUrl: "https://zenmux.ai/api/anthropic",
        envPath: "D:/repo/.env",
        interfaceProvider: "anthropic" as const,
        model: "anthropic/claude-sonnet-4.6",
        modelJsonPath: "D:/home/.ohbaby/model.json",
        provider: "zenmux",
        saved: true as const,
      }),
    );
    const subscribeEvents = vi.fn(() => unsubscribe);
    const createPersistentUiBackendClient = vi.fn(() => ({
      abortRun: vi.fn(() => Promise.resolve()),
      compactSession: vi.fn(() =>
        Promise.resolve({
          sessionId: "session_1",
          status: "not-needed" as const,
          usageAfter: {
            contextLimit: 100,
            currentTokens: 1,
            modelId: "fake-model",
            remainingTokens: 99,
            usageRatio: 0.01,
          },
          usageBefore: {
            contextLimit: 100,
            currentTokens: 1,
            modelId: "fake-model",
            remainingTokens: 99,
            usageRatio: 0.01,
          },
        }),
      ),
      connectModel,
      executeCommand: vi.fn(() => Promise.resolve()),
      getCurrentModel,
      probeModelContextWindow: vi.fn(() =>
        Promise.resolve({
          contextWindowSource: "default" as const,
          contextWindowTokens: 128_000,
        }),
      ),
      getSnapshot: vi.fn(() =>
        Promise.resolve({
          activeSessionId: null,
          permissions: [],
          runs: [],
          sessions: [],
          status: { kind: "idle" as const },
        }),
      ),
      listCommands: vi.fn(() => Promise.resolve({ commands: [] })),
      respondInteraction: vi.fn(() => Promise.resolve()),
      respondPermission: vi.fn(() => Promise.resolve()),
      setPermission: vi.fn(() =>
        Promise.resolve({ level: "default", mode: "auto", sessionRules: [] }),
      ),
      setSearchApiKey: vi.fn(() =>
        Promise.resolve({
          apiKeyEnv: "TAVILY_API_KEY",
          envPath: ".env",
          provider: "tavily" as const,
          searchJsonPath: "search.json",
        }),
      ),
      submitPromptAccepted,
      subscribeEvents,
      waitForPrompt,
    }));
    vi.doMock("../adapters/ui-persistent.js", () => ({
      closePersistentUiBackendDatabase: vi.fn(),
      createPersistentUiBackendClient,
    }));
    vi.doMock("../mcp/index.js", () => ({
      McpManager: { disposeAll: vi.fn(() => Promise.resolve()) },
    }));

    const { buildCoreAPIImpl } = await import("./core-api-factory.js");

    const api = await buildCoreAPIImpl({
      inProcess: true,
      mode: "plan",
      permission: "full-access",
      commandRecorder: { record: (record) => records.push(record) },
    });
    await api.core.submitPromptAndWait("hello");
    await api.core.getCurrentModel();
    await api.core.connectModel({
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      interfaceProvider: "anthropic",
      model: "anthropic/claude-sonnet-4.6",
      provider: "zenmux",
    });
    const handler = vi.fn();
    const result = api.callbacks.subscribeEvents(handler);

    expect(createPersistentUiBackendClient).toHaveBeenCalledWith({
      initialSnapshot: {
        activeSessionId: null,
        permission: {
          level: "full-access",
          mode: "plan",
          sessionRules: [],
        },
        permissions: [],
        runs: [],
        sessions: [],
        status: { kind: "idle" },
      },
    });
    expect(submitPromptAccepted).toHaveBeenCalledWith("hello", {});
    expect(waitForPrompt).toHaveBeenCalledWith("prompt_1", {
      signal: undefined,
    });
    expect(records.map((record) => record.method)).toEqual([
      "submitPromptAccepted",
      "submitPromptAccepted",
      "connectModel",
      "connectModel",
    ]);
    expect(getCurrentModel).toHaveBeenCalledTimes(1);
    expect(connectModel).toHaveBeenCalledWith({
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      interfaceProvider: "anthropic",
      model: "anthropic/claude-sonnet-4.6",
      provider: "zenmux",
    });
    expect(subscribeEvents).toHaveBeenCalledWith(handler);
    expect(result).toBe(unsubscribe);

    const rpc = createRPC<CoreAPI>();
    rpc.connectImpl(api.core);
    const proxy = rpc.createProxy(api.callbacks);
    for (const method of ["waitForPrompt", "submitPromptAndWait"] as const) {
      const controller = new AbortController();
      const pending =
        method === "waitForPrompt"
          ? proxy.waitForPrompt("prompt_1", { signal: controller.signal })
          : proxy.submitPromptAndWait("hello over real CoreAPI seam", {
              clientRequestId: "request_rpc_abort",
              signal: controller.signal,
            });
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    }
  });

  it("disposes MCP and persistent database resources", async () => {
    vi.resetModules();
    const closePersistentUiBackendDatabase = vi.fn();
    const clientDispose = vi.fn(() => Promise.resolve());
    const disposeAll = vi.fn(() => Promise.resolve());
    vi.doMock("../adapters/ui-persistent.js", () => ({
      closePersistentUiBackendDatabase,
      createPersistentUiBackendClient: vi.fn(() => ({
        abortRun: vi.fn(() => Promise.resolve()),
        compactSession: vi.fn(() => Promise.resolve()),
        connectModel: vi.fn(() => Promise.resolve()),
        dispose: clientDispose,
        executeCommand: vi.fn(() => Promise.resolve()),
        getCurrentModel: vi.fn(() => Promise.resolve(null)),
        getSnapshot: vi.fn(() => Promise.resolve()),
        listCommands: vi.fn(() => Promise.resolve({ commands: [] })),
        respondInteraction: vi.fn(() => Promise.resolve()),
        respondPermission: vi.fn(() => Promise.resolve()),
        setPermission: vi.fn(() =>
          Promise.resolve({ level: "default", mode: "auto", sessionRules: [] }),
        ),
        setSearchApiKey: vi.fn(() =>
          Promise.resolve({
            apiKeyEnv: "TAVILY_API_KEY",
            envPath: ".env",
            provider: "tavily" as const,
            searchJsonPath: "search.json",
          }),
        ),
        subscribeEvents: vi.fn((): (() => void) => () => undefined),
      })),
    }));
    vi.doMock("../mcp/index.js", () => ({
      McpManager: { disposeAll },
    }));

    const { buildCoreAPIImpl } = await import("./core-api-factory.js");

    const api = await buildCoreAPIImpl({ inProcess: true });
    await api.dispose();

    expect(clientDispose).toHaveBeenCalledTimes(1);
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(closePersistentUiBackendDatabase).toHaveBeenCalledTimes(1);
  });

  it("leaves an injected recorder lifecycle with its caller", async () => {
    vi.resetModules();
    const client = createPersistentClientMock();
    vi.doMock("../adapters/ui-persistent.js", () => ({
      closePersistentUiBackendDatabase: vi.fn(),
      createPersistentUiBackendClient: vi.fn(() => client),
    }));
    vi.doMock("../mcp/index.js", () => ({
      McpManager: { disposeAll: vi.fn(() => Promise.resolve()) },
    }));
    const recorder = {
      flush: vi.fn(() => Promise.resolve()),
      record: vi.fn(),
    };

    const { buildCoreAPIImpl } = await import("./core-api-factory.js");
    const host = await buildCoreAPIImpl({ commandRecorder: recorder });
    await host.core.executeCommand({
      argv: [],
      clientInvocationId: "invoke_external_recorder",
      commandId: "status",
      path: ["status"],
      raw: "/status",
      rawArgs: "",
      surface: "tui",
    });
    await host.dispose();

    expect(recorder.record).toHaveBeenCalledTimes(2);
    expect(recorder.flush).not.toHaveBeenCalled();
  });

  it("passes continue startup mode to the persistent backend", async () => {
    vi.resetModules();
    const createPersistentUiBackendClient = vi.fn(() => ({
      abortRun: vi.fn(() => Promise.resolve()),
      compactSession: vi.fn(() => Promise.resolve()),
      connectModel: vi.fn(() => Promise.resolve()),
      dispose: vi.fn(() => Promise.resolve()),
      executeCommand: vi.fn(() => Promise.resolve()),
      getContextWindowUsage: vi.fn(() => Promise.resolve(null)),
      getCurrentModel: vi.fn(() => Promise.resolve(null)),
      getSnapshot: vi.fn(() => Promise.resolve()),
      listCommands: vi.fn(() => Promise.resolve({ commands: [] })),
      respondInteraction: vi.fn(() => Promise.resolve()),
      respondPermission: vi.fn(() => Promise.resolve()),
      setPermission: vi.fn(() =>
        Promise.resolve({ level: "default", mode: "auto", sessionRules: [] }),
      ),
      setSearchApiKey: vi.fn(() =>
        Promise.resolve({
          apiKeyEnv: "TAVILY_API_KEY",
          envPath: ".env",
          provider: "tavily" as const,
          searchJsonPath: "search.json",
        }),
      ),
      subscribeEvents: vi.fn((): (() => void) => () => undefined),
    }));
    vi.doMock("../adapters/ui-persistent.js", () => ({
      closePersistentUiBackendDatabase: vi.fn(),
      createPersistentUiBackendClient,
    }));
    vi.doMock("../mcp/index.js", () => ({
      McpManager: { disposeAll: vi.fn(() => Promise.resolve()) },
    }));

    const { buildCoreAPIImpl } = await import("./core-api-factory.js");

    await buildCoreAPIImpl({ continue: true, inProcess: true });

    expect(createPersistentUiBackendClient).toHaveBeenCalledWith({
      startupSessionMode: { type: "continue" },
    });
  });

  it("rejects resume and continue startup modes together", async () => {
    vi.resetModules();
    const createPersistentUiBackendClient = vi.fn();
    vi.doMock("../adapters/ui-persistent.js", () => ({
      closePersistentUiBackendDatabase: vi.fn(),
      createPersistentUiBackendClient,
    }));
    vi.doMock("../mcp/index.js", () => ({
      McpManager: { disposeAll: vi.fn(() => Promise.resolve()) },
    }));

    const { buildCoreAPIImpl } = await import("./core-api-factory.js");

    await expect(
      buildCoreAPIImpl({ continue: true, resume: "session_1" }),
    ).rejects.toThrow("--resume and --continue cannot be used together");
    expect(createPersistentUiBackendClient).not.toHaveBeenCalled();
  });

  it.each([
    ["production", undefined],
    ["production", false],
    ["test", undefined],
    ["test", false],
    ["development", undefined],
    ["development", false],
  ] as const)(
    "keeps the default Agent host off terminal streams with NODE_ENV=%s and commandRecorder=%s",
    async (nodeEnv, commandRecorder) => {
      vi.resetModules();
      vi.stubEnv("NODE_ENV", nodeEnv);
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const client = createPersistentClientMock();
      const createPersistentUiBackendClient = vi.fn(() => client);
      vi.doMock("../adapters/ui-persistent.js", () => ({
        closePersistentUiBackendDatabase: vi.fn(),
        createPersistentUiBackendClient,
      }));
      vi.doMock("../mcp/index.js", () => ({
        McpManager: { disposeAll: vi.fn(() => Promise.resolve()) },
      }));

      const { buildCoreAPIImpl } = await import("./core-api-factory.js");

      try {
        const host = await buildCoreAPIImpl(
          commandRecorder === false ? { commandRecorder } : {},
        );
        expect(createPersistentUiBackendClient).toHaveBeenCalledWith({});
        await host.core.executeCommand({
          argv: [],
          clientInvocationId: "invoke_1",
          commandId: "status",
          path: ["status"],
          raw: "/status",
          rawArgs: "",
          surface: "tui",
        });
        await expect(host.dispose()).resolves.toBeUndefined();

        expect(stdout.mock.calls.flat().join("\n")).not.toContain(
          "ui.command.",
        );
        expect(stderr.mock.calls.flat().join("\n")).not.toContain(
          "ui.command.",
        );
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it("keeps Agent host business writes successful and terminal-silent when the recorder fails", async () => {
    vi.resetModules();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const recorderError = new Error("recorder unavailable");
    recorderError.name = "private-recorder-name";
    const dispose = vi.fn(() => Promise.resolve());
    const createPersistentUiBackendClient = vi.fn(() => ({
      dispose,
      submitPromptAccepted: vi.fn(() =>
        Promise.resolve({
          clientRequestId: "request_1",
          createdAt: "2026-08-15T00:00:00.000Z",
          promptId: "prompt_1",
          sessionId: "session_1",
          status: "queued" as const,
          userMessageId: "message_1",
        }),
      ),
      subscribeEvents: vi.fn(() => vi.fn()),
    }));
    vi.doMock("../adapters/ui-persistent.js", () => ({
      closePersistentUiBackendDatabase: vi.fn(),
      createPersistentUiBackendClient,
    }));
    vi.doMock("../mcp/index.js", () => ({
      McpManager: { disposeAll: vi.fn(() => Promise.resolve()) },
    }));

    try {
      const { buildCoreAPIImpl } = await import("./core-api-factory.js");
      const api = await buildCoreAPIImpl({
        commandRecorder: {
          record(): never {
            throw recorderError;
          },
        },
      });

      await expect(
        api.core.submitPromptAccepted("private prompt"),
      ).resolves.toMatchObject({ promptId: "prompt_1" });
      expect(stdout.mock.calls.flat().join("\n")).not.toContain("ui.command.");
      expect(stderr.mock.calls.flat().join("\n")).not.toContain("ui.command.");
      await api.dispose();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

function createPersistentClientMock(): {
  readonly abortRun: ReturnType<typeof vi.fn>;
  readonly compactSession: ReturnType<typeof vi.fn>;
  readonly connectModel: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly executeCommand: ReturnType<typeof vi.fn>;
  readonly getContextWindowUsage: ReturnType<typeof vi.fn>;
  readonly getCurrentModel: ReturnType<typeof vi.fn>;
  readonly getSnapshot: ReturnType<typeof vi.fn>;
  readonly listCommands: ReturnType<typeof vi.fn>;
  readonly probeModelContextWindow: ReturnType<typeof vi.fn>;
  readonly respondInteraction: ReturnType<typeof vi.fn>;
  readonly respondPermission: ReturnType<typeof vi.fn>;
  readonly setPermission: ReturnType<typeof vi.fn>;
  readonly setSearchApiKey: ReturnType<typeof vi.fn>;
  readonly subscribeEvents: ReturnType<typeof vi.fn>;
} {
  return {
    abortRun: vi.fn(() => Promise.resolve()),
    compactSession: vi.fn(() => Promise.resolve()),
    connectModel: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => Promise.resolve()),
    executeCommand: vi.fn(() => Promise.resolve()),
    getContextWindowUsage: vi.fn(() => Promise.resolve(null)),
    getCurrentModel: vi.fn(() => Promise.resolve(null)),
    getSnapshot: vi.fn(() => Promise.resolve()),
    listCommands: vi.fn(() => Promise.resolve({ commands: [] })),
    probeModelContextWindow: vi.fn(() =>
      Promise.resolve({
        contextWindowSource: "default" as const,
        contextWindowTokens: 128_000,
      }),
    ),
    respondInteraction: vi.fn(() => Promise.resolve()),
    respondPermission: vi.fn(() => Promise.resolve()),
    setPermission: vi.fn(() =>
      Promise.resolve({ level: "default", mode: "auto", sessionRules: [] }),
    ),
    setSearchApiKey: vi.fn(() =>
      Promise.resolve({
        apiKeyEnv: "TAVILY_API_KEY",
        envPath: ".env",
        provider: "tavily" as const,
        searchJsonPath: "search.json",
      }),
    ),
    subscribeEvents: vi.fn((): (() => void) => () => undefined),
  };
}
