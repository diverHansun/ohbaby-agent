import { describe, expect, it, vi } from "vitest";

describe("runOhbabyCli", () => {
  it("creates the default CLI client through the persistent backend factory", async () => {
    vi.resetModules();
    const submitPrompt = vi.fn(() => Promise.resolve());
    const createPersistentUiBackendClient = vi.fn(() => ({
      abortRun: vi.fn(() => Promise.resolve()),
      executeCommand: vi.fn(() => Promise.resolve()),
      getSnapshot: vi.fn(() => Promise.resolve()),
      listCommands: vi.fn(() => Promise.resolve({ commands: [] })),
      respondInteraction: vi.fn(() => Promise.resolve()),
      respondPermission: vi.fn(() => Promise.resolve()),
      submitPrompt,
      subscribeEvents: vi.fn((): (() => void) => () => undefined),
    }));
    vi.doMock("./adapters/ui-persistent.js", () => ({
      closePersistentUiBackendDatabase: vi.fn(),
      createPersistentUiBackendClient,
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(runOhbabyCli(["node", "ohbaby", "-p", "hello"])).resolves.toBe(
      0,
    );
    expect(createPersistentUiBackendClient).toHaveBeenCalledTimes(1);
    expect(submitPrompt).toHaveBeenCalledWith("hello");
  });

  it("passes initial permission flags into the persistent backend", async () => {
    vi.resetModules();
    const submitPrompt = vi.fn(() => Promise.resolve());
    const createPersistentUiBackendClient = vi.fn(() => ({
      abortRun: vi.fn(() => Promise.resolve()),
      executeCommand: vi.fn(() => Promise.resolve()),
      getSnapshot: vi.fn(() => Promise.resolve()),
      listCommands: vi.fn(() => Promise.resolve({ commands: [] })),
      respondInteraction: vi.fn(() => Promise.resolve()),
      respondPermission: vi.fn(() => Promise.resolve()),
      submitPrompt,
      subscribeEvents: vi.fn((): (() => void) => () => undefined),
    }));
    vi.doMock("./adapters/ui-persistent.js", () => ({
      closePersistentUiBackendDatabase: vi.fn(),
      createPersistentUiBackendClient,
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli([
        "node",
        "ohbaby",
        "--mode",
        "plan",
        "--permission",
        "full-access",
        "-p",
        "hello",
      ]),
    ).resolves.toBe(0);

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
    expect(submitPrompt).toHaveBeenCalledWith("hello");
  });

  it("disposes non-interactive MCP and database resources after the prompt completes", async () => {
    vi.resetModules();
    let resolvePrompt!: () => void;
    const submitPrompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    const createPersistentUiBackendClient = vi.fn(() => ({
      abortRun: vi.fn(() => Promise.resolve()),
      executeCommand: vi.fn(() => Promise.resolve()),
      getSnapshot: vi.fn(() => Promise.resolve()),
      listCommands: vi.fn(() => Promise.resolve({ commands: [] })),
      respondInteraction: vi.fn(() => Promise.resolve()),
      respondPermission: vi.fn(() => Promise.resolve()),
      submitPrompt,
      subscribeEvents: vi.fn((): (() => void) => () => undefined),
    }));
    const closePersistentUiBackendDatabase = vi.fn();
    const disposeAll = vi.fn(() => Promise.resolve());
    vi.doMock("./adapters/ui-persistent.js", () => ({
      closePersistentUiBackendDatabase,
      createPersistentUiBackendClient,
    }));
    vi.doMock("./mcp/index.js", () => ({
      McpManager: { disposeAll },
    }));

    const { runOhbabyCli } = await import("./bin.js");

    const run = runOhbabyCli(["node", "ohbaby", "-p", "hello"]);
    await vi.waitFor(() => {
      expect(submitPrompt).toHaveBeenCalled();
    });
    expect(disposeAll).not.toHaveBeenCalled();
    expect(closePersistentUiBackendDatabase).not.toHaveBeenCalled();

    resolvePrompt();

    await expect(run).resolves.toBe(0);
    expect(disposeAll).toHaveBeenCalledTimes(1);
    expect(closePersistentUiBackendDatabase).toHaveBeenCalledTimes(1);
  });
});
