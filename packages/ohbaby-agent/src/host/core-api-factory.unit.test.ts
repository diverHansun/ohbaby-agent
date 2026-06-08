import { describe, expect, it, vi } from "vitest";

describe("buildCoreAPIImpl", () => {
  it("builds CoreAPI and callback adapters from the persistent backend", async () => {
    vi.resetModules();
    const unsubscribe = vi.fn();
    const submitPrompt = vi.fn(() => Promise.resolve());
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

    const api = buildCoreAPIImpl({
      mode: "plan",
      permission: "full-access",
    });
    await api.core.submitPrompt("hello");
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

    const api = buildCoreAPIImpl({});
    await api.dispose();

    expect(clientDispose).toHaveBeenCalledTimes(1);
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(closePersistentUiBackendDatabase).toHaveBeenCalledTimes(1);
  });
});
