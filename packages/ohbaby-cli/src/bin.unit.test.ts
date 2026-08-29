import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { CoreAPI, UiPromptCompletion } from "ohbaby-sdk";
import type { CliCommandRuntime } from "./cli/commands/types.js";

describe("runOhbabyCli", () => {
  it("recognizes npm symlinked bin entrypoints on Unix-like platforms", async () => {
    vi.resetModules();
    const tempDir = join(tmpdir(), "ohbaby-bin");
    const realBinPath = join(
      tempDir,
      "lib",
      "node_modules",
      "ohbaby-cli",
      "dist",
      "bin.js",
    );
    const linkedBinPath = join(tempDir, "bin", "ohbaby");
    const realpath = (value: string): string =>
      value === linkedBinPath ? realBinPath : value;

    const { isDirectCliInvocation } = await import("./bin.js");

    expect(
      isDirectCliInvocation(
        pathToFileURL(realBinPath).href,
        linkedBinPath,
        realpath,
      ),
    ).toBe(true);
  });

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
    const migrateOhbabyData = vi.fn(() =>
      Promise.resolve({
        conflicts: [],
        copied: [],
        merged: [],
        skipped: [],
      }),
    );
    const logger = { emit: vi.fn() };
    const disposeDiagnostics = vi.fn(() => Promise.resolve());
    let diagnosticsUnavailable: (() => void) | undefined;
    const createProcessLogger = vi.fn(
      (options: { readonly onUnavailable?: () => void }) => {
        diagnosticsUnavailable = options.onUnavailable;
        return Promise.resolve({
          dispose: disposeDiagnostics,
          flush: vi.fn(() => Promise.resolve()),
          logFilePath: "/logs/tui.jsonl",
          logger,
        });
      },
    );
    const waitUntilExit = vi.fn(() => Promise.resolve());
    const activeNotice = vi.fn();
    const renderTerminalUi = vi.fn(
      (options: {
        readonly subscribeDiagnosticsUnavailable?: (
          listener: () => void,
        ) => () => void;
      }) => {
        options.subscribeDiagnosticsUnavailable?.(activeNotice);
        diagnosticsUnavailable?.();
        return { waitUntilExit };
      },
    );
    const stderr: string[] = [];
    vi.doMock("ohbaby-agent", () => ({
      buildCoreAPIImpl,
      createProcessLogger,
      dataMigrationCompleted: {},
      loadRuntimeEnvIntoProcessEnv,
      migrateOhbabyData,
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

    await expect(
      runOhbabyCli(["node", "ohbaby"], {
        stderr: { write: (chunk: string) => stderr.push(chunk) },
      }),
    ).resolves.toBe(0);
    expect(loadRuntimeEnvIntoProcessEnv).toHaveBeenCalledTimes(1);
    expect(migrateOhbabyData).toHaveBeenCalledTimes(1);
    expect(
      migrateOhbabyData.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    ).toBeLessThan(
      buildCoreAPIImpl.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(buildCoreAPIImpl).toHaveBeenCalledWith({
      diagnosticsFilePath: "/logs/tui.jsonl",
      inProcess: true,
      logger,
    });
    expect(renderTerminalUi).toHaveBeenCalledTimes(1);
    expect(
      renderTerminalUi.mock.calls[0]?.[0].subscribeDiagnosticsUnavailable,
    ).toBeTypeOf("function");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(disposeDiagnostics).toHaveBeenCalledTimes(1);
    expect(activeNotice).toHaveBeenCalledOnce();
    expect(stderr).toEqual([]);
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
      diagnosticsRole: "tui",
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
    expect(waitUntilExit).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("reports a late diagnostics failure after the terminal UI exits", async () => {
    vi.resetModules();
    const core = createCore();
    const stderr: string[] = [];
    let diagnosticsUnavailable = false;
    const dispose = vi.fn((): Promise<void> => {
      diagnosticsUnavailable = true;
      return Promise.resolve();
    });
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const createCoreHost = vi.fn(() => ({
      callbacks: { subscribeEvents },
      core,
      diagnosticsUnavailable: (): boolean => diagnosticsUnavailable,
      dispose,
    }));
    const loadRuntimeEnvIntoProcessEnv = vi.fn(() => Promise.resolve());
    const waitUntilExit = vi.fn(() => Promise.resolve());
    const renderTerminalUi = vi.fn(() => ({ waitUntilExit }));
    vi.doMock("ohbaby-agent", () => {
      throw new Error("agent should be loaded only by the default loader");
    });
    vi.doMock("./tui/index.js", () => ({ renderTerminalUi }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(
        ["node", "ohbaby"],
        {
          stderr: { write: (chunk: string) => stderr.push(chunk) },
          stdout: { write: vi.fn() },
        },
        { createCoreHost, loadRuntimeEnvIntoProcessEnv },
      ),
    ).resolves.toBe(0);
    expect(waitUntilExit).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(stderr.join("")).toBe(
      "Diagnostics file logging became unavailable; the session continued without it.\n",
    );
  });

  it("presents config migration warnings inside the terminal UI once", async () => {
    vi.resetModules();
    const stderr: string[] = [];
    const core = createCore();
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const renderTerminalUi = vi.fn(() => ({
      waitUntilExit: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("ohbaby-agent", () => {
      throw new Error("agent should be loaded only by the default loader");
    });
    vi.doMock("./tui/index.js", () => ({ renderTerminalUi }));
    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(
        ["node", "ohbaby"],
        { stderr: { write: (chunk: string) => stderr.push(chunk) } },
        {
          createCoreHost: vi.fn(() => ({
            callbacks: { subscribeEvents },
            core,
            dispose: vi.fn(() => Promise.resolve()),
          })),
          loadRuntimeEnvIntoProcessEnv: vi.fn(
            (options?: { readonly onWarning?: (message: string) => void }) => {
              options?.onWarning?.("Legacy configuration conflict.");
            },
          ),
        },
      ),
    ).resolves.toBe(0);

    expect(renderTerminalUi).toHaveBeenCalledWith(
      expect.objectContaining({
        initialNotices: ["Legacy configuration conflict."],
      }),
    );
    expect(stderr.join("")).not.toContain("Legacy configuration conflict.");
  });

  it("falls back to one stderr warning when parsing fails before a presenter", async () => {
    vi.resetModules();
    const stderr: string[] = [];
    vi.doMock("ohbaby-agent", () => ({
      buildCoreAPIImpl: vi.fn(),
      loadRuntimeEnvIntoProcessEnv: vi.fn(
        (options: { readonly onWarning?: (message: string) => void }) => {
          options.onWarning?.("Legacy configuration conflict.");
        },
      ),
    }));
    vi.doMock("./tui/index.js", () => ({ renderTerminalUi: vi.fn() }));
    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(["node", "ohbaby", "--unknown"], {
        stderr: { write: (chunk: string) => stderr.push(chunk) },
        stdout: { write: vi.fn() },
      }),
    ).resolves.toBe(2);

    expect(
      stderr.join("").match(/Legacy configuration conflict\./gu),
    ).toHaveLength(1);
  });

  it("prints a lightweight coexistence notice before starting an in-process terminal", async () => {
    vi.resetModules();
    const stderr: string[] = [];
    const core = createCore();
    const dispose = vi.fn(() => Promise.resolve());
    const createCoreHost = vi.fn(() => ({
      callbacks: { subscribeEvents },
      core,
      dispose,
    }));
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const readServeCoexistenceNotice = vi.fn(() =>
      Promise.resolve("serve is running\n"),
    );
    vi.doMock("ohbaby-agent", () => {
      throw new Error("agent should be loaded only by injected dependencies");
    });
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi: vi.fn(() => ({
        waitUntilExit: (): Promise<void> => Promise.resolve(),
      })),
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(
        ["node", "ohbaby"],
        { stderr: { write: (chunk: string) => stderr.push(chunk) } },
        {
          createCoreHost,
          loadRuntimeEnvIntoProcessEnv: () => Promise.resolve(),
          readServeCoexistenceNotice,
        },
      ),
    ).resolves.toBe(0);
    expect(readServeCoexistenceNotice).toHaveBeenCalledTimes(1);
    expect(stderr.join("")).toContain("serve is running");
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
      diagnosticsRole: "tui",
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
      diagnosticsRole: "tui",
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
      directory: process.cwd(),
      host: "127.0.0.1",
      port: 4096,
      startupIntent: { startupSessionMode: { type: "fresh" } },
    });
    expect(buildCoreAPIImpl).not.toHaveBeenCalled();
    expect(renderTerminalUi).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("preserves receiver-dependent methods on explicit remote hosts", async () => {
    vi.resetModules();
    const core = Object.assign(createCore(), {
      snapshotCalls: 0,
      getSnapshot(): Promise<void> {
        this.snapshotCalls += 1;
        return Promise.resolve();
      },
    });
    const dispose = vi.fn(() => Promise.resolve());
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const createRemoteCoreApiHost = vi.fn(() => ({
      callbacks: { subscribeEvents },
      core,
      dispose,
    }));
    const renderTerminalUi = vi.fn((options: { readonly client: CoreAPI }) => ({
      waitUntilExit: async (): Promise<void> => {
        await options.client.getSnapshot();
      },
    }));
    vi.doMock("ohbaby-agent", () => ({
      buildCoreAPIImpl: vi.fn(() => {
        throw new Error("agent host should not be used for explicit remote");
      }),
      loadRuntimeEnvIntoProcessEnv: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("ohbaby-server", () => ({
      createRemoteCoreApiHost,
      readDaemonStatus: vi.fn(),
      startDaemonServer: vi.fn(),
      stopDaemonFromState: vi.fn(),
    }));
    vi.doMock("./tui/index.js", () => ({ renderTerminalUi }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(["node", "ohbaby", "--remote-port", "4096"]),
    ).resolves.toBe(0);
    expect(core.snapshotCalls).toBe(1);
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
      directory: process.cwd(),
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
      diagnosticsRole: "tui",
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
      diagnosticsRole: "tui",
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
      diagnosticsRole: "tui",
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
    vi.doMock("ohbaby-server", () => {
      throw new Error("ohbaby-server should not be loaded for run subcommand");
    });
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi: vi.fn(),
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(["node", "ohbaby", "run", "hello", "world"]),
    ).resolves.toBe(0);
    expect(core.submitPromptAndWait).toHaveBeenCalledWith("hello world");
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
    const openUrl = vi.fn(() => Promise.resolve());
    const startDaemonServer = vi.fn<CliCommandRuntime["startDaemonServer"]>(
      () =>
        Promise.resolve({
          host: "127.0.0.1",
          port: 4096,
          reused: false,
          scopeRoot: "/repo",
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
      runOhbabyCli(
        ["node", "ohbaby", "serve", "--port", "4096"],
        {
          stdout: { write: (chunk: string) => stdout.push(chunk) },
        },
        { openUrl },
      ),
    ).resolves.toBe(0);
    const serveOptions = startDaemonServer.mock.calls.at(0)?.[0];
    expect(serveOptions).toMatchObject({
      host: "127.0.0.1",
      port: 4096,
    });
    const webAssetsDir = serveOptions?.webAssetsDir ?? "";
    expect(basename(webAssetsDir)).toBe("web");
    expect(basename(dirname(webAssetsDir))).toBe("dist");
    expect(stdout.join("")).toBe("ohbaby web ready: http://127.0.0.1:4096\n");
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:4096");
  });
});

function createCore(): {
  readonly acquirePromptEditLease: ReturnType<typeof vi.fn>;
  readonly abortRun: ReturnType<typeof vi.fn>;
  readonly archiveSession: ReturnType<typeof vi.fn>;
  readonly compactSession: ReturnType<typeof vi.fn>;
  readonly connectModel: ReturnType<typeof vi.fn>;
  readonly cancelQueuedPrompt: ReturnType<typeof vi.fn>;
  readonly editQueuedPrompt: ReturnType<typeof vi.fn>;
  readonly executeCommand: ReturnType<typeof vi.fn>;
  readonly getContextWindowUsage: ReturnType<typeof vi.fn>;
  readonly getCurrentModel: ReturnType<typeof vi.fn>;
  readonly getSnapshot: ReturnType<typeof vi.fn>;
  readonly listCommands: ReturnType<typeof vi.fn>;
  readonly probeModelContextWindow: ReturnType<typeof vi.fn>;
  readonly respondInteraction: ReturnType<typeof vi.fn>;
  readonly respondPermission: ReturnType<typeof vi.fn>;
  readonly releasePromptEditLease: ReturnType<typeof vi.fn>;
  readonly renewPromptEditLease: ReturnType<typeof vi.fn>;
  readonly setPermission: ReturnType<typeof vi.fn>;
  readonly setSearchApiKey: ReturnType<typeof vi.fn>;
  readonly submitPromptAccepted: ReturnType<typeof vi.fn>;
  readonly submitPromptAndWait: ReturnType<typeof vi.fn>;
  readonly waitForPrompt: ReturnType<typeof vi.fn>;
} {
  const prompt = promptCompletion().prompt;
  return {
    acquirePromptEditLease: vi.fn(() =>
      Promise.resolve({
        editLeaseId: "lease_1",
        expiresAt: "2026-08-14T00:01:00.000Z",
        ownerClientId: "client_1",
        prompt,
      }),
    ),
    abortRun: vi.fn(() => Promise.resolve()),
    archiveSession: vi.fn(() => Promise.resolve()),
    cancelQueuedPrompt: vi.fn(() => Promise.resolve(prompt)),
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
    editQueuedPrompt: vi.fn(() => Promise.resolve(prompt)),
    getContextWindowUsage: vi.fn(() => Promise.resolve(null)),
    getCurrentModel: vi.fn(() => Promise.resolve(null)),
    getSnapshot: vi.fn(() => Promise.resolve()),
    listCommands: vi.fn(() => Promise.resolve({ commands: [] })),
    probeModelContextWindow: vi.fn(() =>
      Promise.resolve({
        contextWindowSource: "default",
        contextWindowTokens: 128_000,
      } as const),
    ),
    respondInteraction: vi.fn(() => Promise.resolve()),
    respondPermission: vi.fn(() => Promise.resolve()),
    releasePromptEditLease: vi.fn(() => Promise.resolve(prompt)),
    renewPromptEditLease: vi.fn(() =>
      Promise.resolve({
        editLeaseId: "lease_1",
        expiresAt: "2026-08-14T00:01:00.000Z",
        ownerClientId: "client_1",
        prompt,
      }),
    ),
    setPermission: vi.fn(() =>
      Promise.resolve({
        level: "default",
        mode: "auto",
        sessionRules: [],
      } as const),
    ),
    submitPromptAccepted: vi.fn(() =>
      Promise.resolve({
        clientRequestId: "request_1",
        createdAt: "2026-08-14T00:00:00.000Z",
        promptId: "prompt_1",
        sessionId: "session_1",
        status: "queued" as const,
        userMessageId: "message_1",
      }),
    ),
    submitPromptAndWait: vi.fn(() => Promise.resolve(promptCompletion())),
    waitForPrompt: vi.fn(() => Promise.resolve(promptCompletion())),
  };
}

function promptCompletion(): UiPromptCompletion {
  return {
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
  };
}
