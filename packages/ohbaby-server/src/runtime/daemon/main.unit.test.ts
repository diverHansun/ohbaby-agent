import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import type { UiBackendClient } from "ohbaby-sdk";
import type { PersistentUiBackendOptions } from "ohbaby-agent";

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
    probeModelContextWindow: vi.fn(() =>
      Promise.resolve({
        contextWindowSource: "default" as const,
        contextWindowTokens: 128_000,
      }),
    ),
    setSearchApiKey: vi.fn(() =>
      Promise.resolve({
        apiKeyEnv: "TAVILY_API_KEY",
        envPath: ".env",
        provider: "tavily" as const,
        searchJsonPath: "search.json",
      }),
    ),
    setPermission: vi.fn(
      (input: Parameters<UiBackendClient["setPermission"]>[0]) =>
        Promise.resolve({
          level: input.level ?? "default",
          mode: input.mode ?? "auto",
          sessionRules: [],
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

function createProviderStream(text: string): AsyncGenerator<{
  readonly finishReason: "stop";
  readonly textDelta: string;
}> {
  return (async function* (): AsyncGenerator<{
    readonly finishReason: "stop";
    readonly textDelta: string;
  }> {
    yield await Promise.resolve({ finishReason: "stop", textDelta: text });
  })();
}

function createFakeLLMClient(
  text: string,
): NonNullable<PersistentUiBackendOptions["llmClient"]> {
  return {
    config: {
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      maxTokens: 128,
      model: "fake-model",
      provider: "fake",
      temperature: 0,
    },
    provider: {
      client: { kind: "fake" },
      id: "fake",
      isAbortError(): boolean {
        return false;
      },
      kind: "openai-compatible",
      streamChatCompletion(): Promise<
        AsyncIterable<{
          readonly finishReason: "stop";
          readonly textDelta: string;
        }>
      > {
        return Promise.resolve(createProviderStream(text));
      },
    },
  };
}

describe("startDaemonServer", () => {
  it("uses the agent package version for daemon discovery metadata by default", async () => {
    vi.resetModules();
    let capturedPackageVersion: string | undefined;
    vi.doMock("ohbaby-agent", () => ({
      closePersistentUiBackendDatabase: vi.fn(),
      createSessionIdGenerator: (): (() => string) => () => "session_test",
      createPersistentUiBackendClient: vi.fn(() =>
        createFakeBackend(vi.fn(() => Promise.resolve())),
      ),
      getAgentPackageVersion: (): string => "9.9.9",
      McpManager: { disposeAll: vi.fn(() => Promise.resolve()) },
    }));
    vi.doMock("./server.js", () => ({
      createDaemonHttpServer: vi.fn(
        (options: { readonly packageVersion?: string }) => {
          capturedPackageVersion = options.packageVersion;
          return {
            host: "127.0.0.1",
            port: 4096,
            start: vi.fn(() => Promise.resolve()),
            stop: vi.fn(() => Promise.resolve()),
            url: "http://127.0.0.1:4096",
          };
        },
      ),
    }));

    try {
      const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-main-"));
      const { startDaemonServer } = await import("./main.js");
      try {
        const daemon = await startDaemonServer({
          pidFilePath: join(tempDir, "daemon.pid"),
          port: 0,
          scopeRoot: tempDir,
          stateFilePath: join(tempDir, "daemon-state.json"),
        });
        await daemon.stop();
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }

      expect(capturedPackageVersion).toBe("9.9.9");
    } finally {
      vi.doUnmock("ohbaby-agent");
      vi.doUnmock("./server.js");
    }
  });

  it("uses a default idle timeout for daemon servers", async () => {
    vi.resetModules();
    let capturedIdleTimeoutMs: number | undefined;
    const closePersistentUiBackendDatabase = vi.fn();
    const createPersistentUiBackendClient = vi.fn(() =>
      createFakeBackend(vi.fn(() => Promise.resolve())),
    );
    vi.doMock("ohbaby-agent", () => ({
      closePersistentUiBackendDatabase,
      createSessionIdGenerator: (): (() => string) => () => "session_test",
      createPersistentUiBackendClient,
      getAgentPackageVersion: (): string => "0.1.0",
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
      const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-main-"));
      const { startDaemonServer } = await import("./main.js");
      try {
        await startDaemonServer({
          pidFilePath: join(tempDir, "daemon.pid"),
          port: 0,
          scopeRoot: tempDir,
          stateFilePath: join(tempDir, "daemon-state.json"),
        });
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }

      expect(capturedIdleTimeoutMs).toBe(15 * 60 * 1000);
    } finally {
      vi.doUnmock("ohbaby-agent");
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
    vi.doMock("ohbaby-agent", () => ({
      closePersistentUiBackendDatabase,
      createSessionIdGenerator: (): (() => string) => () => "session_test",
      createPersistentUiBackendClient,
      getAgentPackageVersion: (): string => "0.1.0",
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
        scopeRoot: tempDir,
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
        scopeRoot: tempDir,
        status: "running",
      });

      await daemon.stop();
    } finally {
      vi.doUnmock("ohbaby-agent");
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("reuses a healthy server state for the same scope", async () => {
    vi.resetModules();
    const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-main-"));
    const stateFilePath = join(tempDir, "daemon-state.json");
    const scopeRoot = join(tempDir, "repo");
    await mkdir(scopeRoot, { recursive: true });
    await writeFile(
      stateFilePath,
      `${JSON.stringify({
        authToken: "token_1",
        host: "127.0.0.1",
        packageVersion: "0.1.0",
        pid: process.pid,
        port: 4096,
        scopeRoot,
        status: "running",
        updatedAt: Date.now(),
      })}\n`,
      "utf8",
    );

    try {
      const { startDaemonServer } = await import("./main.js");
      const daemon = await startDaemonServer({
        healthCheck: () => Promise.resolve(true),
        pidFilePath: join(tempDir, "daemon.pid"),
        scopeRoot,
        stateFilePath,
      });

      expect(daemon).toMatchObject({
        host: "127.0.0.1",
        port: 4096,
        reused: true,
        scopeRoot,
        url: "http://127.0.0.1:4096",
      });
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects changing the explicit port for an already running same-scope server", async () => {
    vi.resetModules();
    const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-main-"));
    const disposeAll = vi.fn(() => Promise.resolve());
    const closePersistentUiBackendDatabase = vi.fn();
    const createPersistentUiBackendClient = vi.fn(() =>
      createFakeBackend(vi.fn(() => Promise.resolve())),
    );
    vi.doMock("ohbaby-agent", () => ({
      closePersistentUiBackendDatabase,
      createSessionIdGenerator: (): (() => string) => () => "session_test",
      createPersistentUiBackendClient,
      getAgentPackageVersion: (): string => "0.1.0",
      McpManager: { disposeAll },
    }));

    try {
      const scopeRoot = join(tempDir, "repo");
      const pidFilePath = join(tempDir, "daemon.pid");
      const stateFilePath = join(tempDir, "daemon-state.json");
      const { startDaemonServer } = await import("./main.js");
      const daemon = await startDaemonServer({
        pidFilePath,
        port: 0,
        scopeRoot,
        stateFilePath,
      });
      const requestedPort =
        daemon.port === 65_535 ? daemon.port - 1 : daemon.port + 1;

      await expect(
        startDaemonServer({
          pidFilePath,
          port: requestedPort,
          scopeRoot,
          stateFilePath,
        }),
      ).rejects.toThrow(/already running.*stop.*changing host or port/iu);

      await daemon.stop();
    } finally {
      vi.doUnmock("ohbaby-agent");
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects changing the explicit host for an already running same-scope server", async () => {
    vi.resetModules();
    const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-main-"));
    const disposeAll = vi.fn(() => Promise.resolve());
    const closePersistentUiBackendDatabase = vi.fn();
    const createPersistentUiBackendClient = vi.fn(() =>
      createFakeBackend(vi.fn(() => Promise.resolve())),
    );
    vi.doMock("ohbaby-agent", () => ({
      closePersistentUiBackendDatabase,
      createSessionIdGenerator: (): (() => string) => () => "session_test",
      createPersistentUiBackendClient,
      getAgentPackageVersion: (): string => "0.1.0",
      McpManager: { disposeAll },
    }));

    try {
      const scopeRoot = join(tempDir, "repo");
      const pidFilePath = join(tempDir, "daemon.pid");
      const stateFilePath = join(tempDir, "daemon-state.json");
      const { startDaemonServer } = await import("./main.js");
      const daemon = await startDaemonServer({
        pidFilePath,
        port: 0,
        scopeRoot,
        stateFilePath,
      });

      await expect(
        startDaemonServer({
          host: "localhost",
          pidFilePath,
          scopeRoot,
          stateFilePath,
        }),
      ).rejects.toThrow(/already running.*stop.*changing host or port/iu);

      await daemon.stop();
    } finally {
      vi.doUnmock("ohbaby-agent");
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("fails clearly when a same-scope live pid does not answer health checks", async () => {
    vi.resetModules();
    const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-main-"));
    const stateFilePath = join(tempDir, "daemon-state.json");
    const scopeRoot = join(tempDir, "repo");
    await mkdir(scopeRoot, { recursive: true });
    await writeFile(
      stateFilePath,
      `${JSON.stringify({
        authToken: "token_1",
        host: "127.0.0.1",
        packageVersion: "0.1.0",
        pid: process.pid,
        port: 4096,
        scopeRoot,
        status: "running",
        updatedAt: Date.now(),
      })}\n`,
      "utf8",
    );

    try {
      const { startDaemonServer } = await import("./main.js");
      await expect(
        startDaemonServer({
          healthCheck: () => Promise.resolve(false),
          pidFilePath: join(tempDir, "daemon.pid"),
          scopeRoot,
          stateFilePath,
        }),
      ).rejects.toThrow(/running.*did not answer.*health/iu);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("reuses the running server when the workdir resolves to the same git root", async () => {
    vi.resetModules();
    const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-scope-"));
    const repo = join(tempDir, "repo");
    const child = join(repo, "packages", "app");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(child, { recursive: true });
    const disposeAll = vi.fn(() => Promise.resolve());
    const closePersistentUiBackendDatabase = vi.fn();
    const createPersistentUiBackendClient = vi.fn(() =>
      createFakeBackend(vi.fn(() => Promise.resolve())),
    );
    vi.doMock("ohbaby-agent", async (importOriginal) => {
      const actual = await importOriginal<typeof import("ohbaby-agent")>();
      return {
        ...actual,
        closePersistentUiBackendDatabase,
        createPersistentUiBackendClient,
        getAgentPackageVersion: (): string => "0.1.0",
        McpManager: { disposeAll },
      };
    });

    try {
      const { startDaemonServer } = await import("./main.js");
      const first = await startDaemonServer({
        defaultPort: 0,
        workdir: repo,
      });
      const second = await startDaemonServer({
        defaultPort: 0,
        workdir: child,
      });

      expect(second.reused).toBe(true);
      expect(second.scopeRoot).toBe(first.scopeRoot);
      expect(second.url).toBe(first.url);

      await first.stop();
    } finally {
      vi.doUnmock("ohbaby-agent");
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("falls back to an OS-assigned port when the default port is busy and --port was omitted", async () => {
    vi.resetModules();
    const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-main-"));
    const disposeAll = vi.fn(() => Promise.resolve());
    const closePersistentUiBackendDatabase = vi.fn();
    const createPersistentUiBackendClient = vi.fn(() =>
      createFakeBackend(vi.fn(() => Promise.resolve())),
    );
    vi.doMock("ohbaby-agent", () => ({
      closePersistentUiBackendDatabase,
      createSessionIdGenerator: (): (() => string) => () => "session_test",
      createPersistentUiBackendClient,
      getAgentPackageVersion: (): string => "0.1.0",
      McpManager: { disposeAll },
    }));

    try {
      const { startDaemonServer } = await import("./main.js");
      const first = await startDaemonServer({
        pidFilePath: join(tempDir, "first.pid"),
        port: 0,
        scopeRoot: join(tempDir, "repo-a"),
        stateFilePath: join(tempDir, "first-state.json"),
      });
      const second = await startDaemonServer({
        defaultPort: first.port,
        pidFilePath: join(tempDir, "second.pid"),
        scopeRoot: join(tempDir, "repo-b"),
        stateFilePath: join(tempDir, "second-state.json"),
      });

      expect(second.port).not.toBe(first.port);

      await second.stop();
      await first.stop();
    } finally {
      vi.doUnmock("ohbaby-agent");
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("throws a helpful error when an explicit port is busy", async () => {
    vi.resetModules();
    const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-main-"));
    const disposeAll = vi.fn(() => Promise.resolve());
    const closePersistentUiBackendDatabase = vi.fn();
    const createPersistentUiBackendClient = vi.fn(() =>
      createFakeBackend(vi.fn(() => Promise.resolve())),
    );
    vi.doMock("ohbaby-agent", () => ({
      closePersistentUiBackendDatabase,
      createSessionIdGenerator: (): (() => string) => () => "session_test",
      createPersistentUiBackendClient,
      getAgentPackageVersion: (): string => "0.1.0",
      McpManager: { disposeAll },
    }));

    try {
      const { startDaemonServer } = await import("./main.js");
      const first = await startDaemonServer({
        pidFilePath: join(tempDir, "first.pid"),
        port: 0,
        scopeRoot: join(tempDir, "repo-a"),
        stateFilePath: join(tempDir, "first-state.json"),
      });

      await expect(
        startDaemonServer({
          pidFilePath: join(tempDir, "second.pid"),
          port: first.port,
          scopeRoot: join(tempDir, "repo-b"),
          stateFilePath: join(tempDir, "second-state.json"),
        }),
      ).rejects.toThrow(`Port ${String(first.port)} is already in use`);

      await first.stop();
    } finally {
      vi.doUnmock("ohbaby-agent");
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("reads daemon status from the current project-root scope", async () => {
    vi.resetModules();
    const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-status-"));
    const repoA = join(tempDir, "repo-a");
    const repoB = join(tempDir, "repo-b");
    await mkdir(join(repoA, ".git"), { recursive: true });
    await mkdir(join(repoB, ".git"), { recursive: true });
    await mkdir(join(repoA, ".ohbaby", "server"), { recursive: true });
    await mkdir(join(repoB, ".ohbaby", "server"), { recursive: true });
    await writeFile(
      join(repoA, ".ohbaby", "server", "daemon-state.json"),
      `${JSON.stringify({
        authToken: "token_a",
        host: "127.0.0.1",
        packageVersion: "0.1.0",
        pid: 11,
        port: 4101,
        scopeRoot: repoA,
        status: "running",
        updatedAt: Date.now(),
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(repoB, ".ohbaby", "server", "daemon-state.json"),
      `${JSON.stringify({
        authToken: "token_b",
        host: "127.0.0.1",
        packageVersion: "0.1.0",
        pid: 22,
        port: 4102,
        scopeRoot: repoB,
        status: "running",
        updatedAt: Date.now(),
      })}\n`,
      "utf8",
    );

    try {
      const { readDaemonStatus } = await import("./main.js");
      await expect(readDaemonStatus({ workdir: repoA })).resolves.toMatchObject(
        {
          port: 4101,
          scopeRoot: repoA,
        },
      );
      await expect(readDaemonStatus({ workdir: repoB })).resolves.toMatchObject(
        {
          port: 4102,
          scopeRoot: repoB,
        },
      );
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("stops only the current scope when state owns the pid lock", async () => {
    vi.resetModules();
    const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-stop-"));
    const repoA = join(tempDir, "repo-a");
    const repoB = join(tempDir, "repo-b");
    await mkdir(join(repoA, ".git"), { recursive: true });
    await mkdir(join(repoB, ".git"), { recursive: true });
    await mkdir(join(repoA, ".ohbaby", "server"), { recursive: true });
    await mkdir(join(repoB, ".ohbaby", "server"), { recursive: true });
    await writeFile(
      join(repoA, ".ohbaby", "server", "daemon.pid"),
      `${JSON.stringify({ pid: 111, startedAt: 1, token: "token_a" })}\n`,
      "utf8",
    );
    await writeFile(
      join(repoA, ".ohbaby", "server", "daemon-state.json"),
      `${JSON.stringify({
        authToken: "auth_a",
        host: "127.0.0.1",
        packageVersion: "0.1.0",
        pid: 111,
        pidToken: "token_a",
        port: 4101,
        scopeRoot: repoA,
        status: "running",
        updatedAt: Date.now(),
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(repoB, ".ohbaby", "server", "daemon.pid"),
      `${JSON.stringify({ pid: 222, startedAt: 1, token: "token_b" })}\n`,
      "utf8",
    );
    await writeFile(
      join(repoB, ".ohbaby", "server", "daemon-state.json"),
      `${JSON.stringify({
        authToken: "auth_b",
        host: "127.0.0.1",
        packageVersion: "0.1.0",
        pid: 222,
        pidToken: "token_b",
        port: 4102,
        scopeRoot: repoB,
        status: "running",
        updatedAt: Date.now(),
      })}\n`,
      "utf8",
    );
    const kill = vi.fn();

    try {
      const { stopDaemonFromState } = await import("./main.js");
      await expect(stopDaemonFromState({ kill, workdir: repoA })).resolves.toBe(
        "stopped",
      );
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(111, "SIGTERM");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("refuses to stop when state does not own the pid lock", async () => {
    vi.resetModules();
    const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-stop-"));
    const repo = join(tempDir, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, ".ohbaby", "server"), { recursive: true });
    await writeFile(
      join(repo, ".ohbaby", "server", "daemon.pid"),
      `${JSON.stringify({ pid: 111, startedAt: 1, token: "new_owner" })}\n`,
      "utf8",
    );
    await writeFile(
      join(repo, ".ohbaby", "server", "daemon-state.json"),
      `${JSON.stringify({
        authToken: "auth",
        host: "127.0.0.1",
        packageVersion: "0.1.0",
        pid: 111,
        pidToken: "old_owner",
        port: 4101,
        scopeRoot: repo,
        status: "running",
        updatedAt: Date.now(),
      })}\n`,
      "utf8",
    );
    const kill = vi.fn();

    try {
      const { stopDaemonFromState } = await import("./main.js");
      await expect(
        stopDaemonFromState({ kill, workdir: repo }),
      ).rejects.toThrow(/refusing to stop/i);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("keeps two foreground daemons on different project roots isolated with one sqlite database", async () => {
    vi.resetModules();
    const tempDir = await mkdtemp(join(tmpdir(), "ohbaby-daemon-sqlite-"));
    const repoA = join(tempDir, "repo-a");
    const repoB = join(tempDir, "repo-b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });

    const dbPath = join(tempDir, "agent.db");
    const authTokenA = "token_a";
    const authTokenB = "token_b";
    let daemonA:
      | Awaited<ReturnType<(typeof import("./main.js"))["startDaemonServer"]>>
      | undefined;
    let daemonB:
      | Awaited<ReturnType<(typeof import("./main.js"))["startDaemonServer"]>>
      | undefined;
    let clientA:
      | ReturnType<
          (typeof import("../../protocols/jsonrpc/client.js"))["createRemoteUiBackendClient"]
        >
      | undefined;
    let clientB:
      | ReturnType<
          (typeof import("../../protocols/jsonrpc/client.js"))["createRemoteUiBackendClient"]
        >
      | undefined;

    try {
      const { startDaemonServer } = await import("./main.js");
      const { createRemoteUiBackendClient } =
        await import("../../protocols/jsonrpc/client.js");
      daemonA = await startDaemonServer({
        authToken: authTokenA,
        dbPath,
        defaultPort: 0,
        llmClient: createFakeLLMClient("Project A response"),
        workdir: repoA,
      });
      daemonB = await startDaemonServer({
        authToken: authTokenB,
        dbPath,
        defaultPort: daemonA.port,
        llmClient: createFakeLLMClient("Project B response"),
        workdir: repoB,
      });
      clientA = createRemoteUiBackendClient({
        authToken: authTokenA,
        host: daemonA.host,
        port: daemonA.port,
      });
      clientB = createRemoteUiBackendClient({
        authToken: authTokenB,
        host: daemonB.host,
        port: daemonB.port,
      });

      await clientA.submitPrompt("Prompt for project A");
      await clientB.submitPrompt("Prompt for project B");

      const snapshotA = await clientA.getSnapshot();
      const snapshotB = await clientB.getSnapshot();
      const serializedA = JSON.stringify(snapshotA);
      const serializedB = JSON.stringify(snapshotB);

      expect(daemonB.port).not.toBe(daemonA.port);
      expect(snapshotA.activeSessionId).toBeTruthy();
      expect(snapshotB.activeSessionId).toBeTruthy();
      expect(snapshotA.activeSessionId).not.toBe(snapshotB.activeSessionId);
      expect(serializedA).toContain("Prompt for project A");
      expect(serializedA).not.toContain("Prompt for project B");
      expect(serializedB).toContain("Prompt for project B");
      expect(serializedB).not.toContain("Prompt for project A");
    } finally {
      await clientA?.dispose();
      await clientB?.dispose();
      await daemonB?.stop();
      await daemonA?.stop();
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
    vi.doMock("ohbaby-agent", () => ({
      closePersistentUiBackendDatabase,
      createSessionIdGenerator: (): (() => string) => () => "session_test",
      createPersistentUiBackendClient,
      getAgentPackageVersion: (): string => "0.1.0",
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
      vi.doUnmock("ohbaby-agent");
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
