import { describe, expect, it, vi } from "vitest";
import yargs from "yargs/yargs";
import { createServeCommand } from "./serve.js";
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

interface CreatedRuntime {
  readonly runtime: CliCommandRuntime;
  readonly startDaemonServer: StartDaemonServerMock;
  readonly readDaemonStatus: ReadDaemonStatusMock;
  readonly stopDaemonFromState: StopDaemonFromStateMock;
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
  const runtime: CliCommandRuntime = {
    createCoreHost: vi.fn(),
    createStdoutRenderer: vi.fn(),
    failUsage(message: string): never {
      throw new Error(message);
    },
    isStdinTTY: (): boolean => true,
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
    readDaemonStatus,
    runtime,
    startDaemonServer,
    stderr,
    stdout,
    stopDaemonFromState,
  };
}

describe("createServeCommand", () => {
  it("starts a foreground daemon and prints the listening url", async () => {
    const { runtime, startDaemonServer, stdout } = createRuntime();

    await runServe(["serve", "--port", "4096"], runtime);

    expect(startDaemonServer).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 4096,
    });
    expect(stdout.join("")).toContain("http://127.0.0.1:4096");
  });

  it("accepts port 0 so auto-spawned daemons can bind a free port", async () => {
    const { runtime, startDaemonServer } = createRuntime();

    await runServe(["serve", "--port", "0"], runtime);

    expect(startDaemonServer).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 0,
    });
  });

  it("passes an explicit auth token to the daemon server", async () => {
    const { runtime, startDaemonServer } = createRuntime();

    await runServe(["serve", "--auth-token", "token_1"], runtime);

    expect(startDaemonServer).toHaveBeenCalledWith({
      authToken: "token_1",
      host: "127.0.0.1",
      port: 4096,
    });
  });

  it("passes a web assets directory to the daemon server", async () => {
    const { runtime, startDaemonServer } = createRuntime();

    await runServe(
      ["serve", "--web-assets-dir", "apps/ohbaby-web/dist"],
      runtime,
    );

    expect(startDaemonServer).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 4096,
      webAssetsDir: "apps/ohbaby-web/dist",
    });
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
