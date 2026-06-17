import { describe, expect, it, vi } from "vitest";

describe("runOhbabyCli", () => {
  it("loads the CLI version from package metadata", async () => {
    vi.resetModules();
    const getCliPackageVersion = vi.fn(() => "9.9.9");
    vi.doMock("./package-version.js", () => ({
      getCliPackageVersion,
    }));
    vi.doMock("ohbaby-agent", () => {
      throw new Error("agent should be loaded only by injected dependencies");
    });
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi: vi.fn(),
    }));

    try {
      await import("./bin.js");

      expect(getCliPackageVersion).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("./package-version.js");
      vi.doUnmock("ohbaby-agent");
      vi.doUnmock("./tui/index.js");
    }
  });

  it("starts the default terminal through ohbaby-agent without loading ohbaby-server", async () => {
    vi.resetModules();
    const core = createCore();
    const dispose = vi.fn(() => Promise.resolve());
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const buildCoreAPIImpl = vi.fn(() => ({
      callbacks: { subscribeEvents },
      core,
      dispose,
    }));
    const loadRuntimeEnvIntoProcessEnv = vi.fn(() => Promise.resolve());
    const waitUntilExit = vi.fn(() => Promise.resolve());
    const renderTerminalUi = vi.fn(() => ({ waitUntilExit }));
    vi.doMock("ohbaby-agent", () => ({
      buildCoreAPIImpl,
      loadRuntimeEnvIntoProcessEnv,
    }));
    vi.doMock("ohbaby-server", () => {
      throw new Error(
        "ohbaby-server should not be loaded for default terminal",
      );
    });
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi,
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(runOhbabyCli(["node", "ohbaby"])).resolves.toBe(0);
    expect(loadRuntimeEnvIntoProcessEnv).toHaveBeenCalledTimes(1);
    expect(buildCoreAPIImpl).toHaveBeenCalledWith({
      inProcess: true,
    });
    expect(renderTerminalUi).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("starts the terminal UI through injected host dependencies", async () => {
    vi.resetModules();
    const core = createCore();
    const createCoreHost = vi.fn(() => ({
      callbacks: { subscribeEvents },
      core,
      dispose,
    }));
    const dispose = vi.fn(() => Promise.resolve());
    const loadRuntimeEnvIntoProcessEnv = vi.fn(() => Promise.resolve());
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const waitUntilExit = vi.fn(() => Promise.resolve());
    const renderTerminalUi = vi.fn(() => ({ waitUntilExit }));
    vi.doMock("ohbaby-agent", () => {
      throw new Error("agent should be loaded only by the default loader");
    });
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi,
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(
        ["node", "ohbaby", "--mode", "plan", "--permission", "full-access"],
        {},
        {
          createCoreHost,
          loadRuntimeEnvIntoProcessEnv,
        },
      ),
    ).resolves.toBe(0);
    expect(loadRuntimeEnvIntoProcessEnv).toHaveBeenCalledTimes(1);
    expect(createCoreHost).toHaveBeenCalledWith({
      inProcess: true,
      mode: "plan",
      permission: "full-access",
    });
    const renderCalls = renderTerminalUi.mock.calls as unknown as [
      {
        readonly client: unknown;
        readonly subscribeEvents: unknown;
      },
    ][];
    const renderOptions = renderCalls[0]?.[0] as
      | {
          readonly client: unknown;
          readonly subscribeEvents: unknown;
        }
      | undefined;
    expect(renderOptions?.client).toBeTypeOf("object");
    expect(renderOptions?.subscribeEvents).toBeTypeOf("function");
    const handler = vi.fn();
    (
      renderOptions?.subscribeEvents as
        | ((nextHandler: typeof handler) => unknown)
        | undefined
    )?.(handler);
    expect(subscribeEvents).toHaveBeenCalledWith(handler);
    expect(core.submitPrompt).not.toHaveBeenCalled();
    expect(waitUntilExit).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects the removed --in-process flag", async () => {
    vi.resetModules();
    const stderr: string[] = [];
    vi.doMock("ohbaby-agent", () => ({
      buildCoreAPIImpl: vi.fn(),
      loadRuntimeEnvIntoProcessEnv: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi: vi.fn(),
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(["node", "ohbaby", "--in-process"], {
        stderr: { write: (chunk: string) => stderr.push(chunk) },
        stdout: { write: vi.fn() },
      }),
    ).resolves.toBe(2);
    expect(stderr.join("")).toContain("Unknown argument");
  });

  it("rejects the removed --daemon flag", async () => {
    vi.resetModules();
    const stderr: string[] = [];
    vi.doMock("ohbaby-agent", () => ({
      buildCoreAPIImpl: vi.fn(),
      loadRuntimeEnvIntoProcessEnv: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi: vi.fn(),
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(["node", "ohbaby", "--daemon"], {
        stderr: { write: (chunk: string) => stderr.push(chunk) },
        stdout: { write: vi.fn() },
      }),
    ).resolves.toBe(2);
    expect(stderr.join("")).toContain("Unknown argument");
  });

  it("rejects the removed --no-daemon alias", async () => {
    vi.resetModules();
    const stderr: string[] = [];
    vi.doMock("ohbaby-agent", () => ({
      buildCoreAPIImpl: vi.fn(),
      loadRuntimeEnvIntoProcessEnv: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi: vi.fn(),
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(["node", "ohbaby", "--no-daemon"], {
        stderr: { write: (chunk: string) => stderr.push(chunk) },
        stdout: { write: vi.fn() },
      }),
    ).resolves.toBe(2);
    expect(stderr.join("")).toContain("Unknown argument");
  });

  it("preflights the terminal UI when resuming a session at startup", async () => {
    vi.resetModules();
    const core = createCore();
    const dispose = vi.fn(() => Promise.resolve());
    const createCoreHost = vi.fn(() => ({
      callbacks: { subscribeEvents },
      core,
      dispose,
    }));
    const loadRuntimeEnvIntoProcessEnv = vi.fn(() => Promise.resolve());
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const waitUntilExit = vi.fn(() => Promise.resolve());
    const renderTerminalUi = vi.fn(() => ({ waitUntilExit }));
    vi.doMock("ohbaby-agent", () => {
      throw new Error("agent should be loaded only by the default loader");
    });
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi,
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(
        ["node", "ohbaby", "--resume", "session_2"],
        {},
        {
          createCoreHost,
          loadRuntimeEnvIntoProcessEnv,
        },
      ),
    ).resolves.toBe(0);
    expect(createCoreHost).toHaveBeenCalledWith({
      inProcess: true,
      resume: "session_2",
    });
    expect(core.getSnapshot).toHaveBeenCalledTimes(1);
    expect(renderTerminalUi).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("passes remote server options to the terminal host", async () => {
    vi.resetModules();
    const core = createCore();
    const dispose = vi.fn(() => Promise.resolve());
    const createCoreHost = vi.fn(() => ({
      callbacks: { subscribeEvents },
      core,
      dispose,
    }));
    const loadRuntimeEnvIntoProcessEnv = vi.fn(() => Promise.resolve());
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const waitUntilExit = vi.fn(() => Promise.resolve());
    const renderTerminalUi = vi.fn(() => ({ waitUntilExit }));
    vi.doMock("ohbaby-agent", () => {
      throw new Error("agent should be loaded only by the default loader");
    });
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi,
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(
        ["node", "ohbaby", "--remote-port", "4096"],
        {},
        {
          createCoreHost,
          loadRuntimeEnvIntoProcessEnv,
        },
      ),
    ).resolves.toBe(0);
    expect(createCoreHost).toHaveBeenCalledWith({
      remoteHost: "127.0.0.1",
      remotePort: 4096,
    });
    expect(renderTerminalUi).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("loads explicit remote hosts from ohbaby-server", async () => {
    vi.resetModules();
    const core = createCore();
    const dispose = vi.fn(() => Promise.resolve());
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const createRemoteCoreApiHost = vi.fn(() => ({
      callbacks: { subscribeEvents },
      core,
      dispose,
    }));
    const buildCoreAPIImpl = vi.fn(() => {
      throw new Error("agent host should not be used for explicit remote");
    });
    const loadRuntimeEnvIntoProcessEnv = vi.fn(() => Promise.resolve());
    const waitUntilExit = vi.fn(() => Promise.resolve());
    const renderTerminalUi = vi.fn(() => ({ waitUntilExit }));
    vi.doMock("ohbaby-agent", () => ({
      buildCoreAPIImpl,
      loadRuntimeEnvIntoProcessEnv,
    }));
    vi.doMock("ohbaby-server", () => ({
      createRemoteCoreApiHost,
      readDaemonStatus: vi.fn(),
      startDaemonServer: vi.fn(),
      stopDaemonFromState: vi.fn(),
    }));
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi,
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(["node", "ohbaby", "--remote-port", "4096"]),
    ).resolves.toBe(0);
    expect(createRemoteCoreApiHost).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 4096,
      startupIntent: { startupSessionMode: { type: "fresh" } },
    });
    expect(buildCoreAPIImpl).not.toHaveBeenCalled();
    expect(renderTerminalUi).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("maps remote auth and startup intent before loading ohbaby-server", async () => {
    vi.resetModules();
    const core = createCore();
    const dispose = vi.fn(() => Promise.resolve());
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const createRemoteCoreApiHost = vi.fn(() => ({
      callbacks: { subscribeEvents },
      core,
      dispose,
    }));
    const buildCoreAPIImpl = vi.fn(() => {
      throw new Error("agent host should not be used for explicit remote");
    });
    const loadRuntimeEnvIntoProcessEnv = vi.fn(() => Promise.resolve());
    const waitUntilExit = vi.fn(() => Promise.resolve());
    const renderTerminalUi = vi.fn(() => ({ waitUntilExit }));
    vi.doMock("ohbaby-agent", () => ({
      buildCoreAPIImpl,
      loadRuntimeEnvIntoProcessEnv,
    }));
    vi.doMock("ohbaby-server", () => ({
      createRemoteCoreApiHost,
      readDaemonStatus: vi.fn(),
      startDaemonServer: vi.fn(),
      stopDaemonFromState: vi.fn(),
    }));
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi,
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli([
        "node",
        "ohbaby",
        "--remote-port",
        "4096",
        "--remote-auth-token",
        "token_1",
        "--resume",
        "session_1",
        "--mode",
        "plan",
        "--permission",
        "full-access",
      ]),
    ).resolves.toBe(0);
    expect(createRemoteCoreApiHost).toHaveBeenCalledWith({
      authToken: "token_1",
      host: "127.0.0.1",
      port: 4096,
      startupIntent: {
        initialPermission: { level: "full-access", mode: "plan" },
        resumeSessionId: "session_1",
        startupSessionMode: { type: "fresh" },
      },
    });
    expect(buildCoreAPIImpl).not.toHaveBeenCalled();
    expect(renderTerminalUi).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("passes an explicit remote server auth token to the terminal host", async () => {
    vi.resetModules();
    const core = createCore();
    const dispose = vi.fn(() => Promise.resolve());
    const createCoreHost = vi.fn(() => ({
      callbacks: { subscribeEvents },
      core,
      dispose,
    }));
    const loadRuntimeEnvIntoProcessEnv = vi.fn(() => Promise.resolve());
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const waitUntilExit = vi.fn(() => Promise.resolve());
    const renderTerminalUi = vi.fn(() => ({ waitUntilExit }));
    vi.doMock("ohbaby-agent", () => {
      throw new Error("agent should be loaded only by the default loader");
    });
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi,
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(
        [
          "node",
          "ohbaby",
          "--remote-port",
          "4096",
          "--remote-auth-token",
          "token_1",
        ],
        {},
        {
          createCoreHost,
          loadRuntimeEnvIntoProcessEnv,
        },
      ),
    ).resolves.toBe(0);
    expect(createCoreHost).toHaveBeenCalledWith({
      remoteAuthToken: "token_1",
      remoteHost: "127.0.0.1",
      remotePort: 4096,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("preserves resume options when using a remote server", async () => {
    vi.resetModules();
    const core = createCore();
    const dispose = vi.fn(() => Promise.resolve());
    const createCoreHost = vi.fn(() => ({
      callbacks: { subscribeEvents },
      core,
      dispose,
    }));
    const loadRuntimeEnvIntoProcessEnv = vi.fn(() => Promise.resolve());
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const waitUntilExit = vi.fn(() => Promise.resolve());
    const renderTerminalUi = vi.fn(() => ({ waitUntilExit }));
    vi.doMock("ohbaby-agent", () => {
      throw new Error("agent should be loaded only by the default loader");
    });
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi,
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(
        ["node", "ohbaby", "--remote-port", "4096", "--resume", "session_1"],
        {},
        {
          createCoreHost,
          loadRuntimeEnvIntoProcessEnv,
        },
      ),
    ).resolves.toBe(0);
    expect(createCoreHost).toHaveBeenCalledWith({
      remoteHost: "127.0.0.1",
      remotePort: 4096,
      resume: "session_1",
    });
    expect(core.getSnapshot).toHaveBeenCalledTimes(1);
    expect(renderTerminalUi).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("preflights the terminal UI when continuing the latest session at startup", async () => {
    vi.resetModules();
    const core = createCore();
    const dispose = vi.fn(() => Promise.resolve());
    const createCoreHost = vi.fn(() => ({
      callbacks: { subscribeEvents },
      core,
      dispose,
    }));
    const loadRuntimeEnvIntoProcessEnv = vi.fn(() => Promise.resolve());
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const waitUntilExit = vi.fn(() => Promise.resolve());
    const renderTerminalUi = vi.fn(() => ({ waitUntilExit }));
    vi.doMock("ohbaby-agent", () => {
      throw new Error("agent should be loaded only by the default loader");
    });
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi,
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(
        ["node", "ohbaby", "--continue"],
        {},
        {
          createCoreHost,
          loadRuntimeEnvIntoProcessEnv,
        },
      ),
    ).resolves.toBe(0);
    expect(createCoreHost).toHaveBeenCalledWith({
      continue: true,
      inProcess: true,
    });
    expect(core.getSnapshot).toHaveBeenCalledTimes(1);
    expect(renderTerminalUi).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects resume and continue together before rendering", async () => {
    vi.resetModules();
    const stderr: string[] = [];
    const core = createCore();
    const dispose = vi.fn(() => Promise.resolve());
    const createCoreHost = vi.fn(() => ({
      callbacks: { subscribeEvents },
      core,
      dispose,
    }));
    const loadRuntimeEnvIntoProcessEnv = vi.fn(() => Promise.resolve());
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const renderTerminalUi = vi.fn();
    vi.doMock("ohbaby-agent", () => {
      throw new Error("agent should be loaded only by the default loader");
    });
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi,
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(
        ["node", "ohbaby", "--resume", "session_2", "--continue"],
        {
          stderr: { write: (chunk: string) => stderr.push(chunk) },
          stdout: { write: vi.fn() },
        },
        {
          createCoreHost,
          loadRuntimeEnvIntoProcessEnv,
        },
      ),
    ).resolves.toBe(2);
    expect(stderr.join("")).toContain(
      "--resume and --continue cannot be used together",
    );
    expect(createCoreHost).not.toHaveBeenCalled();
    expect(renderTerminalUi).not.toHaveBeenCalled();
  });

  it("fails startup before rendering when resume preflight fails", async () => {
    vi.resetModules();
    const core = createCore();
    core.getSnapshot.mockRejectedValue(new Error("Session not found: missing"));
    const dispose = vi.fn(() => Promise.resolve());
    const createCoreHost = vi.fn(() => ({
      callbacks: { subscribeEvents },
      core,
      dispose,
    }));
    const loadRuntimeEnvIntoProcessEnv = vi.fn(() => Promise.resolve());
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const renderTerminalUi = vi.fn();
    vi.doMock("ohbaby-agent", () => {
      throw new Error("agent should be loaded only by the default loader");
    });
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi,
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(
        ["node", "ohbaby", "--resume", "missing"],
        {},
        {
          createCoreHost,
          loadRuntimeEnvIntoProcessEnv,
        },
      ),
    ).rejects.toThrow("Session not found: missing");
    expect(renderTerminalUi).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("runs a prompt through the run subcommand and disposes resources", async () => {
    vi.resetModules();
    const core = createCore();
    const dispose = vi.fn(() => Promise.resolve());
    const unsubscribe = vi.fn();
    const subscribeEvents = vi.fn(() => unsubscribe);
    vi.doMock("ohbaby-agent", () => ({
      buildCoreAPIImpl: vi.fn(() => ({
        callbacks: { subscribeEvents },
        core,
        dispose,
      })),
      loadRuntimeEnvIntoProcessEnv: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi: vi.fn(),
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(["node", "ohbaby", "run", "hello", "world"]),
    ).resolves.toBe(0);
    expect(core.submitPrompt).toHaveBeenCalledWith("hello world");
    expect(subscribeEvents).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects the old prompt flag instead of accepting bare startup prompts", async () => {
    vi.resetModules();
    const stderr: string[] = [];
    vi.doMock("ohbaby-agent", () => ({
      buildCoreAPIImpl: vi.fn(),
      loadRuntimeEnvIntoProcessEnv: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi: vi.fn(),
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(["node", "ohbaby", "-p", "hello"], {
        stderr: { write: (chunk: string) => stderr.push(chunk) },
        stdout: { write: vi.fn() },
      }),
    ).resolves.toBe(2);
    expect(stderr.join("")).toContain("Unknown argument");
  });

  it("starts the serve subcommand through default runtime dependencies", async () => {
    vi.resetModules();
    const stdout: string[] = [];
    const startDaemonServer = vi.fn(() =>
      Promise.resolve({
        host: "127.0.0.1",
        port: 4096,
        stop: vi.fn(() => Promise.resolve()),
        url: "http://127.0.0.1:4096",
      }),
    );
    vi.doMock("ohbaby-agent", () => ({
      buildCoreAPIImpl: vi.fn(),
      loadRuntimeEnvIntoProcessEnv: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("ohbaby-server", () => ({
      readDaemonStatus: vi.fn(() => Promise.resolve(undefined)),
      startDaemonServer,
      stopDaemonFromState: vi.fn(() => Promise.resolve("not-running")),
    }));
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi: vi.fn(),
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(["node", "ohbaby", "serve", "--port", "4096"], {
        stdout: { write: (chunk: string) => stdout.push(chunk) },
      }),
    ).resolves.toBe(0);
    expect(startDaemonServer).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 4096,
    });
    expect(stdout.join("")).toContain("http://127.0.0.1:4096");
  });
});

function createCore(): {
  readonly abortRun: ReturnType<typeof vi.fn>;
  readonly compactSession: ReturnType<typeof vi.fn>;
  readonly connectModel: ReturnType<typeof vi.fn>;
  readonly executeCommand: ReturnType<typeof vi.fn>;
  readonly getContextWindowUsage: ReturnType<typeof vi.fn>;
  readonly getCurrentModel: ReturnType<typeof vi.fn>;
  readonly getSnapshot: ReturnType<typeof vi.fn>;
  readonly listCommands: ReturnType<typeof vi.fn>;
  readonly respondInteraction: ReturnType<typeof vi.fn>;
  readonly respondPermission: ReturnType<typeof vi.fn>;
  readonly setSearchApiKey: ReturnType<typeof vi.fn>;
  readonly submitPrompt: ReturnType<typeof vi.fn>;
} {
  return {
    abortRun: vi.fn(() => Promise.resolve()),
    compactSession: vi.fn(() => Promise.resolve()),
    connectModel: vi.fn(() =>
      Promise.resolve({
        apiKeyEnv: "ZENMUX_API_KEY",
        baseUrl: "https://api.example.com",
        envPath: ".env",
        interfaceProvider: "openai-compatible",
        model: "example-model",
        modelJsonPath: "model.json",
        provider: "example",
        saved: true,
      } as const),
    ),
    setSearchApiKey: vi.fn(() =>
      Promise.resolve({
        apiKeyEnv: "TAVILY_API_KEY",
        envPath: ".env",
        provider: "tavily",
        searchJsonPath: "search.json",
      } as const),
    ),
    executeCommand: vi.fn(() => Promise.resolve()),
    getContextWindowUsage: vi.fn(() => Promise.resolve(null)),
    getCurrentModel: vi.fn(() => Promise.resolve(null)),
    getSnapshot: vi.fn(() => Promise.resolve()),
    listCommands: vi.fn(() => Promise.resolve({ commands: [] })),
    respondInteraction: vi.fn(() => Promise.resolve()),
    respondPermission: vi.fn(() => Promise.resolve()),
    submitPrompt: vi.fn(() => Promise.resolve()),
  };
}
