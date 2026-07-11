import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import yargs from "yargs/yargs";
import { createServeCommand, resolveBundledWebAssetsDir } from "./serve.js";
import type { CliCommandRuntime } from "./types.js";

type StartDaemonServerMock = ReturnType<
  typeof vi.fn<CliCommandRuntime["startDaemonServer"]>
>;
type ReadDaemonStatusMock = ReturnType<
  typeof vi.fn<CliCommandRuntime["readDaemonStatus"]>
>;
type StopDaemonFromStateMock = ReturnType<
  typeof vi.fn<CliCommandRuntime["stopDaemonFromState"]>
>;
type OpenUrlMock = ReturnType<typeof vi.fn<CliCommandRuntime["openUrl"]>>;
type ListDaemonConnectionsMock = ReturnType<
  typeof vi.fn<NonNullable<CliCommandRuntime["listDaemonConnections"]>>
>;

interface CreatedRuntime {
  readonly runtime: CliCommandRuntime;
  readonly startDaemonServer: StartDaemonServerMock;
  readonly readDaemonStatus: ReadDaemonStatusMock;
  readonly stopDaemonFromState: StopDaemonFromStateMock;
  readonly openUrl: OpenUrlMock;
  readonly listDaemonConnections: ListDaemonConnectionsMock;
  readonly stderr: string[];
  readonly stdout: string[];
}

async function runServe(
  argv: readonly string[],
  runtime: CliCommandRuntime,
): Promise<void> {
  await yargs([...argv])
    .scriptName("ohbaby")
    .command(createServeCommand(runtime))
    .demandCommand(1)
    .strict()
    .exitProcess(false)
    .fail((message) => {
      throw new Error(message);
    })
    .parseAsync();
}

function createRuntime(): CreatedRuntime {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const startDaemonServer = vi.fn<CliCommandRuntime["startDaemonServer"]>(() =>
    Promise.resolve({
      host: "127.0.0.1",
      port: 4096,
      reused: false,
      scopeRoot: "/repo",
      stop: (): Promise<void> => Promise.resolve(),
      url: "http://127.0.0.1:4096",
    }),
  );
  const readDaemonStatus = vi.fn<CliCommandRuntime["readDaemonStatus"]>(() =>
    Promise.resolve({
      pid: 1234,
      startedAt: 1,
      status: "running" as const,
      updatedAt: 2,
    }),
  );
  const stopDaemonFromState = vi.fn<CliCommandRuntime["stopDaemonFromState"]>(
    () => Promise.resolve("stopped"),
  );
  const openUrl = vi.fn<CliCommandRuntime["openUrl"]>(() => Promise.resolve());
  const listDaemonConnections = vi.fn<
    NonNullable<CliCommandRuntime["listDaemonConnections"]>
  >(() =>
    Promise.resolve([
      {
        clientId: "client_web",
        connectedAt: 42_000,
        scopeKey: "/repo",
      },
    ]),
  );
  const runtime: CliCommandRuntime = {
    createCoreHost: vi.fn(),
    createStdoutRenderer: vi.fn(),
    failUsage(message: string): never {
      throw new Error(message);
    },
    isStdinTTY: (): boolean => true,
    listDaemonConnections,
    openUrl,
    readDaemonStatus,
    readStdin: (): Promise<string> => Promise.resolve(""),
    renderTerminalUi: vi.fn(),
    setExitCode: vi.fn(),
    startDaemonServer,
    stderr: { write: (chunk: string): number => stderr.push(chunk) },
    stdout: { write: (chunk: string): number => stdout.push(chunk) },
    stopDaemonFromState,
  };
  return {
    listDaemonConnections,
    readDaemonStatus,
    runtime,
    openUrl,
    startDaemonServer,
    stderr,
    stdout,
    stopDaemonFromState,
  };
}

function firstStartOptions(
  startDaemonServer: StartDaemonServerMock,
): Parameters<CliCommandRuntime["startDaemonServer"]>[0] {
  const call = startDaemonServer.mock.calls.at(0);
  if (!call) {
    throw new Error("startDaemonServer was not called");
  }
  return call[0];
}

function expectBundledWebAssetsDir(value: string | undefined): void {
  expect(value).toEqual(expect.any(String));
  expect(value).toMatch(/dist\/web$/u);
}

describe("createServeCommand", () => {
  it("resolves bundled web assets next to the built CLI bundle", () => {
    const builtBundleUrl = pathToFileURL(
      resolve(process.cwd(), "packages", "ohbaby-cli", "dist", "bin.js"),
    ).href;

    expect(resolveBundledWebAssetsDir(builtBundleUrl)).toBe(
      resolve(process.cwd(), "packages", "ohbaby-cli", "dist", "web"),
    );
  });

  it("starts a foreground daemon, prints the web url, and opens the browser", async () => {
    const { openUrl, runtime, startDaemonServer, stdout } = createRuntime();

    await runServe(["serve", "--port", "4096"], runtime);

    const options = firstStartOptions(startDaemonServer);
    expect(options).toMatchObject({
      host: "127.0.0.1",
      port: 4096,
    });
    expectBundledWebAssetsDir(options.webAssetsDir);
    expect(stdout.join("")).toBe("ohbaby web ready: http://127.0.0.1:4096\n");
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:4096");
  });

  it("passes bundled web assets without a port when the user omitted --port", async () => {
    const { runtime, startDaemonServer } = createRuntime();

    await runServe(["serve"], runtime);

    const options = firstStartOptions(startDaemonServer);
    expect(options).toMatchObject({
      host: "127.0.0.1",
    });
    expectBundledWebAssetsDir(options.webAssetsDir);
  });

  it("does not pass bundled web assets when binding a non-loopback host", async () => {
    const { runtime, startDaemonServer } = createRuntime();

    await runServe(["serve", "--host", "0.0.0.0"], runtime);

    expect(startDaemonServer).toHaveBeenCalledWith({
      host: "0.0.0.0",
    });
  });

  it("keeps the daemon running when browser opening fails", async () => {
    const { openUrl, runtime, stderr, stdout } = createRuntime();
    openUrl.mockRejectedValueOnce(new Error("no browser"));

    await runServe(["serve"], runtime);

    expect(stdout.join("")).toBe("ohbaby web ready: http://127.0.0.1:4096\n");
    expect(stderr.join("")).toContain("Could not open browser automatically");
  });

  it("accepts port 0 so auto-spawned daemons can bind a free port", async () => {
    const { runtime, startDaemonServer } = createRuntime();

    await runServe(["serve", "--port", "0"], runtime);

    const options = firstStartOptions(startDaemonServer);
    expect(options).toMatchObject({
      host: "127.0.0.1",
      port: 0,
    });
    expectBundledWebAssetsDir(options.webAssetsDir);
  });

  it("passes an explicit auth token to the daemon server", async () => {
    const { runtime, startDaemonServer } = createRuntime();

    await runServe(["serve", "--auth-token", "token_1"], runtime);

    const options = firstStartOptions(startDaemonServer);
    expect(options).toMatchObject({
      authToken: "token_1",
      host: "127.0.0.1",
    });
    expectBundledWebAssetsDir(options.webAssetsDir);
  });

  it("passes a web assets directory to the daemon server", async () => {
    const { runtime, startDaemonServer } = createRuntime();

    await runServe(
      ["serve", "--web-assets-dir", "apps/ohbaby-web/dist"],
      runtime,
    );

    expect(startDaemonServer).toHaveBeenCalledWith({
      host: "127.0.0.1",
      webAssetsDir: "apps/ohbaby-web/dist",
    });
  });

  it("rejects web assets on non-loopback hosts", async () => {
    const { runtime, startDaemonServer } = createRuntime();

    await expect(
      runServe(
        [
          "serve",
          "--host",
          "0.0.0.0",
          "--web-assets-dir",
          "apps/ohbaby-web/dist",
        ],
        runtime,
      ),
    ).rejects.toThrow(
      "--web-assets-dir can only be used with a loopback --host",
    );
    expect(startDaemonServer).not.toHaveBeenCalled();
  });

  it("prints daemon status from the state file", async () => {
    const { readDaemonStatus, runtime, stdout } = createRuntime();

    await runServe(["serve", "status"], runtime);

    expect(readDaemonStatus).toHaveBeenCalledTimes(1);
    expect(stdout.join("")).toContain("running");
    expect(stdout.join("")).toContain("1234");
  });

  it("prints not-running when status has no daemon state", async () => {
    const { readDaemonStatus, runtime, stdout } = createRuntime();
    readDaemonStatus.mockResolvedValueOnce(undefined);

    await runServe(["serve", "status"], runtime);

    expect(stdout.join("")).toContain("not-running");
  });

  it("prints active daemon connections with serve ps", async () => {
    const { listDaemonConnections, runtime, stdout } = createRuntime();

    await runServe(["serve", "ps"], runtime);

    expect(listDaemonConnections).toHaveBeenCalledTimes(1);
    expect(stdout.join("")).toContain("client_web");
    expect(stdout.join("")).toContain("/repo");
  });

  it("stops a daemon from recorded state", async () => {
    const { runtime, stdout, stopDaemonFromState } = createRuntime();

    await runServe(["serve", "stop"], runtime);

    expect(stopDaemonFromState).toHaveBeenCalledTimes(1);
    expect(stdout.join("")).toContain("stopped");
  });

  it("exits cleanly when no daemon is running during stop", async () => {
    const { runtime, stdout, stopDaemonFromState } = createRuntime();
    stopDaemonFromState.mockResolvedValueOnce("not-running");

    await runServe(["serve", "stop"], runtime);

    expect(stdout.join("")).toContain("not-running");
  });
});
