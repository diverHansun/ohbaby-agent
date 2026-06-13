import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import type { UiBackendClient } from "ohbaby-sdk";

function createFakeBackend(dispose: () => Promise<void>): UiBackendClient & {
  dispose(): Promise<void>;
} {
  return {
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
    connectModel: vi.fn(() =>
      Promise.resolve({
        apiKeyEnv: "FAKE_API_KEY",
        baseUrl: "https://example.invalid/v1",
        contextWindowSource: "default" as const,
        contextWindowTokens: 100,
        envPath: ".env",
        interfaceProvider: "openai-compatible" as const,
        model: "fake-model",
        modelJsonPath: "model.json",
        provider: "fake",
        saved: true as const,
      }),
    ),
    dispose,
    executeCommand: vi.fn(() => Promise.resolve()),
    getContextWindowUsage: vi.fn(() => Promise.resolve(null)),
    getCurrentModel: vi.fn(() => Promise.resolve(null)),
    getSnapshot: vi.fn(() =>
      Promise.resolve({
        activeSessionId: null,
        permissions: [],
        runs: [],
        sessions: [],
        status: { kind: "idle" as const },
      }),
    ),
    listCommands: vi.fn(() => Promise.resolve({ commands: [], version: "v1" })),
    respondInteraction: vi.fn(() => Promise.resolve()),
    respondPermission: vi.fn(() => Promise.resolve()),
    submitPrompt: vi.fn(() => Promise.resolve()),
    subscribeEvents: vi.fn(() => vi.fn()),
  };
}

describe("startDaemonServer", () => {
  it("uses a default idle timeout for daemon servers", async () => {
    vi.resetModules();
    let capturedIdleTimeoutMs: number | undefined;
    const closePersistentUiBackendDatabase = vi.fn();
    const createPersistentUiBackendClient = vi.fn(() =>
      createFakeBackend(vi.fn(() => Promise.resolve())),
    );
    vi.doMock("../../adapters/ui-persistent.js", () => ({
      closePersistentUiBackendDatabase,
      createPersistentUiBackendClient,
    }));
    vi.doMock("../../mcp/index.js", () => ({
      McpManager: { disposeAll: vi.fn(() => Promise.resolve()) },
    }));
    vi.doMock("./server.js", () => ({
      createDaemonHttpServer: vi.fn(() => ({
        host: "127.0.0.1",
        port: 4096,
        start: vi.fn(() => Promise.resolve()),
        stop: vi.fn(() => Promise.resolve()),
        url: "http://127.0.0.1:4096",
      })),
    }));
    vi.doMock("./supervisor.js", () => ({
      Supervisor: class {
        constructor(
          private readonly options: {
            readonly bootstrap: () => {
              readonly start: () => Promise<void>;
              readonly stop: () => Promise<void>;
            };
            readonly idleTimeoutMs?: number;
          },
        ) {
          capturedIdleTimeoutMs = options.idleTimeoutMs;
        }

        async start(): Promise<void> {
          await this.options.bootstrap().start();
        }

        stop(): Promise<void> {
          return Promise.resolve();
        }
      },
    }));

    try {
      const { startDaemonServer } = await import("./main.js");
      await startDaemonServer({ port: 0 });

      expect(capturedIdleTimeoutMs).toBe(15 * 60 * 1000);
    } finally {
      vi.doUnmock("../../adapters/ui-persistent.js");
      vi.doUnmock("../../mcp/index.js");
      vi.doUnmock("./server.js");
      vi.doUnmock("./supervisor.js");
    }
  });

  it("writes connection metadata to the daemon state file", async () => {
    vi.resetModules();
    const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-main-"));
    const disposeAll = vi.fn(() => Promise.resolve());
    const closePersistentUiBackendDatabase = vi.fn();
    const createPersistentUiBackendClient = vi.fn(() =>
      createFakeBackend(vi.fn(() => Promise.resolve())),
    );
    vi.doMock("../../adapters/ui-persistent.js", () => ({
      closePersistentUiBackendDatabase,
      createPersistentUiBackendClient,
    }));
    vi.doMock("../../mcp/index.js", () => ({
      McpManager: { disposeAll },
    }));

    try {
      const stateFilePath = join(tempDir, "daemon-state.json");
      const { startDaemonServer } = await import("./main.js");
      const daemon = await startDaemonServer({
        authToken: "token_1",
        packageVersion: "0.1.0",
        pidFilePath: join(tempDir, "daemon.pid"),
        port: 0,
        stateFilePath,
      });

      const state = JSON.parse(await readFile(stateFilePath, "utf8")) as Record<
        string,
        unknown
      >;
      expect(state).toMatchObject({
        authToken: "token_1",
        host: "127.0.0.1",
        packageVersion: "0.1.0",
        pid: process.pid,
        port: daemon.port,
        status: "running",
      });

      await daemon.stop();
    } finally {
      vi.doUnmock("../../adapters/ui-persistent.js");
      vi.doUnmock("../../mcp/index.js");
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("disposes MCP managers when the daemon stops", async () => {
    vi.resetModules();
    const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-main-"));
    const disposeBackend = vi.fn(() => Promise.resolve());
    const disposeAll = vi.fn(() => Promise.resolve());
    const closePersistentUiBackendDatabase = vi.fn();
    const createPersistentUiBackendClient = vi.fn(() =>
      createFakeBackend(disposeBackend),
    );
    vi.doMock("../../adapters/ui-persistent.js", () => ({
      closePersistentUiBackendDatabase,
      createPersistentUiBackendClient,
    }));
    vi.doMock("../../mcp/index.js", () => ({
      McpManager: { disposeAll },
    }));

    try {
      const { startDaemonServer } = await import("./main.js");
      const daemon = await startDaemonServer({
        pidFilePath: join(tempDir, "daemon.pid"),
        port: 0,
        stateFilePath: join(tempDir, "daemon-state.json"),
      });

      await daemon.stop();

      expect(disposeBackend).toHaveBeenCalledTimes(1);
      expect(disposeAll).toHaveBeenCalledTimes(1);
      expect(closePersistentUiBackendDatabase).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("../../adapters/ui-persistent.js");
      vi.doUnmock("../../mcp/index.js");
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
