import { describe, expect, it, vi } from "vitest";

describe("runOhbabyCli", () => {
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
      daemon: true,
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

  it("uses in-process mode when requested", async () => {
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
        ["node", "ohbaby", "--in-process"],
        {},
        {
          createCoreHost,
          loadRuntimeEnvIntoProcessEnv,
        },
      ),
    ).resolves.toBe(0);
    expect(createCoreHost).toHaveBeenCalledWith({
      daemon: false,
      inProcess: true,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps --no-daemon as an alias for in-process mode", async () => {
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
        ["node", "ohbaby", "--no-daemon"],
        {},
        {
          createCoreHost,
          loadRuntimeEnvIntoProcessEnv,
        },
      ),
    ).resolves.toBe(0);
    expect(createCoreHost).toHaveBeenCalledWith({
      daemon: false,
      inProcess: true,
    });
    expect(dispose).toHaveBeenCalledTimes(1);
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
      daemon: true,
      resume: "session_2",
    });
    expect(core.getSnapshot).toHaveBeenCalledTimes(1);
    expect(renderTerminalUi).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("passes remote daemon options to the terminal host", async () => {
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

  it("preserves resume options when using a remote daemon", async () => {
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
          "--resume",
          "session_1",
        ],
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
      daemon: true,
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
