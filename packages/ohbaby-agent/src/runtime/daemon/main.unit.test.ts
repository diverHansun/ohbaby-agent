import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
