import { describe, expect, it, vi } from "vitest";

describe("buildCoreAPIImpl", () => {
  it("builds CoreAPI and callback adapters from the persistent backend", async () => {
    vi.resetModules();
    const unsubscribe = vi.fn();
    const submitPrompt = vi.fn(() => Promise.resolve());
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
      submitPrompt,
      subscribeEvents,
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
    });
    await api.core.submitPrompt("hello");
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
    expect(submitPrompt).toHaveBeenCalledWith("hello", undefined);
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
        submitPrompt: vi.fn(() => Promise.resolve()),
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
      submitPrompt: vi.fn(() => Promise.resolve()),
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

  it("uses the in-process persistent backend by default", async () => {
    vi.resetModules();
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

    const host = await buildCoreAPIImpl({});
    expect(createPersistentUiBackendClient).toHaveBeenCalledWith({});
    await expect(host.dispose()).resolves.toBeUndefined();
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
  readonly submitPrompt: ReturnType<typeof vi.fn>;
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
    submitPrompt: vi.fn(() => Promise.resolve()),
    subscribeEvents: vi.fn((): (() => void) => () => undefined),
  };
}
