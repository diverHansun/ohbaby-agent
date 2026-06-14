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
        modelJsonPath: "D:/home/.ohbaby-agent/model.json",
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
            shouldCompress: false,
            usageRatio: 0.01,
          },
          usageBefore: {
            contextLimit: 100,
            currentTokens: 1,
            modelId: "fake-model",
            remainingTokens: 99,
            shouldCompress: false,
            usageRatio: 0.01,
          },
        }),
      ),
      connectModel,
      executeCommand: vi.fn(() => Promise.resolve()),
      getCurrentModel,
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

  it("uses a remote daemon host when remote port is provided", async () => {
    vi.resetModules();
    const createPersistentUiBackendClient = vi.fn();
    const remoteHost = {
      callbacks: { subscribeEvents: vi.fn() },
      core: {},
      dispose: vi.fn(() => Promise.resolve()),
    };
    const createRemoteCoreApiHost = vi.fn(() => remoteHost);
    vi.doMock("../adapters/ui-persistent.js", () => ({
      closePersistentUiBackendDatabase: vi.fn(),
      createPersistentUiBackendClient,
    }));
    vi.doMock("../mcp/index.js", () => ({
      McpManager: { disposeAll: vi.fn(() => Promise.resolve()) },
    }));
    vi.doMock("../runtime/daemon/client.js", () => ({
      createRemoteCoreApiHost,
    }));

    const { buildCoreAPIImpl } = await import("./core-api-factory.js");

    const api = await buildCoreAPIImpl({
      remoteHost: "127.0.0.1",
      remotePort: 4096,
    });

    expect(api).toBe(remoteHost);
    expect(createRemoteCoreApiHost).toHaveBeenCalledWith({
      authToken: undefined,
      host: "127.0.0.1",
      port: 4096,
      startupIntent: { startupSessionMode: { type: "fresh" } },
    });
    expect(createPersistentUiBackendClient).not.toHaveBeenCalled();
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

  it("uses an auto-spawned daemon by default", async () => {
    vi.resetModules();
    const remoteHost = {
      callbacks: { subscribeEvents: vi.fn() },
      core: {},
      dispose: vi.fn(() => Promise.resolve()),
    };
    const createRemoteCoreApiHost = vi.fn(() => remoteHost);
    const ensureDaemonRunning = vi.fn(() =>
      Promise.resolve({
        authToken: "token_1",
        host: "127.0.0.1",
        packageVersion: "0.1.0",
        port: 4096,
      }),
    );
    const createPersistentUiBackendClient = vi.fn();
    vi.doMock("../runtime/daemon/client.js", () => ({
      createRemoteCoreApiHost,
    }));
    vi.doMock("../runtime/daemon/spawn.js", () => ({
      ensureDaemonRunning,
    }));
    vi.doMock("../package-version.js", () => ({
      getAgentPackageVersion: (): string => "9.9.9",
    }));
    vi.doMock("../adapters/ui-persistent.js", () => ({
      closePersistentUiBackendDatabase: vi.fn(),
      createPersistentUiBackendClient,
    }));
    vi.doMock("../mcp/index.js", () => ({
      McpManager: { disposeAll: vi.fn(() => Promise.resolve()) },
    }));

    const { buildCoreAPIImpl } = await import("./core-api-factory.js");

    await expect(buildCoreAPIImpl({})).resolves.toBe(remoteHost);
    expect(ensureDaemonRunning).toHaveBeenCalledWith({
      currentVersion: "9.9.9",
    });
    expect(createRemoteCoreApiHost).toHaveBeenCalledWith({
      authToken: "token_1",
      host: "127.0.0.1",
      port: 4096,
      startupIntent: { startupSessionMode: { type: "fresh" } },
    });
    expect(createPersistentUiBackendClient).not.toHaveBeenCalled();
  });
});
