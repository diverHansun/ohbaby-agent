import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCoreAPIImpl,
  startDaemonServer,
  type CoreApiHost,
  type RunningDaemonServer,
} from "../../../packages/ohbaby-agent/src/index.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirectories.push(directory);
  return directory;
}

describe("daemon auto-spawn terminal flow", () => {
  it("starts one daemon for two default core hosts", async () => {
    const home = await tempDirectory("ohbaby-daemon-auto-spawn-");
    const stateFilePath = join(home, "daemon-state.json");
    const spawned: string[] = [];
    let daemon: RunningDaemonServer | undefined;
    let first: CoreApiHost | undefined;
    let second: CoreApiHost | undefined;

    try {
      const spawnDaemon = async (): Promise<void> => {
        spawned.push("spawn");
        daemon = await startDaemonServer({
          dbPath: join(home, "agent.db"),
          host: "127.0.0.1",
          pidFilePath: join(home, "daemon.pid"),
          port: 0,
          stateFilePath,
          workdir: home,
        });
      };

      first = await buildCoreAPIImpl({
        daemon: true,
        daemonPollIntervalMs: 0,
        daemonSpawn: spawnDaemon,
        daemonStateFilePath: stateFilePath,
      });
      second = await buildCoreAPIImpl({
        daemon: true,
        daemonPollIntervalMs: 0,
        daemonSpawn: spawnDaemon,
        daemonStateFilePath: stateFilePath,
      });

      await first.core.getSnapshot();
      await second.core.getSnapshot();
      expect(spawned).toEqual(["spawn"]);
    } finally {
      await first?.dispose();
      await second?.dispose();
      await daemon?.stop();
    }
  }, 30_000);
});
