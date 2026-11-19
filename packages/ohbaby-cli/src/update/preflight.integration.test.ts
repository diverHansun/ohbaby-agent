import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { runUpgradePreflight } from "./preflight.js";

const { resolveOhbabyHome } =
  await vi.importActual<typeof import("ohbaby-agent")>("ohbaby-agent");
const { inspectDaemonForMaintenance, stopDaemonFromState } =
  await vi.importActual<typeof import("ohbaby-server")>("ohbaby-server");

it("waits for real daemon exit and its matching cleanup report", async () => {
  const root = await mkdtemp(join(tmpdir(), "ohbaby-idle-shutdown-"));
  const home = join(root, "ohbaby");
  const workdir = join(root, "workspace");
  const fixture = join(root, "daemon.mjs");
  const daemonModule = pathToFileURL(
    resolve("packages/ohbaby-server/src/runtime/daemon/main.ts"),
  ).href;
  const env = {
    ...process.env,
    OHBABY_HOME: home,
    XDG_DATA_HOME: join(root, "data"),
    APPDATA: join(root, "data"),
    LOCALAPPDATA: join(root, "data"),
  };
  await mkdir(workdir);
  await writeFile(
    fixture,
    `import { startDaemonServer } from ${JSON.stringify(daemonModule)};
await startDaemonServer({
  authToken: "temporary-token", defaultPort: 0,
  dbPath: ${JSON.stringify(join(root, "sessions.db"))},
  workdir: ${JSON.stringify(workdir)}
});
process.send("ready");`,
  );

  const child = fork(fixture, {
    env,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const exited = once(child, "exit");
  try {
    await Promise.race([
      once(child, "message"),
      exited.then(([code]) => {
        throw new Error(`Daemon exited before readiness: ${String(code)}`);
      }),
    ]);
    const options = {
      installMethod: {
        kind: "script" as const,
        installDir: join(home, "install"),
      },
      env,
    };
    const state = JSON.parse(
      await readFile(join(home, "server", "daemon-state.json"), "utf8"),
    ) as {
      pid: number;
      pidToken: string;
    };
    const runtime = {
      resolveOhbabyHome,
      inspectDaemonForMaintenance,
      stopDaemonFromState,
    };
    expect(await runUpgradePreflight(options, runtime)).toEqual({
      ok: true,
      stoppedDaemon: true,
    });
    expect(await exited).toEqual([0, null]);
    expect(
      JSON.parse(
        await readFile(join(home, "server", "daemon-shutdown.json"), "utf8"),
      ),
    ).toMatchObject({
      pid: state.pid,
      pidToken: state.pidToken,
      cleanup: { status: "confirmed" },
    });
    expect(await runUpgradePreflight(options, runtime)).toEqual({
      ok: true,
      stoppedDaemon: false,
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
