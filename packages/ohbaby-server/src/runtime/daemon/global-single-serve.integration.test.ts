import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface ChildReady {
  readonly pid: number;
  readonly reused: boolean;
  readonly url: string;
}

const children: ChildProcessWithoutNullStreams[] = [];
const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child).catch(() => undefined);
    }
  }
  await Promise.all(
    cleanupDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function spawnServe(input: {
  readonly dbPath: string;
  readonly homeDirectory: string;
  readonly workdir: string;
}): ChildProcessWithoutNullStreams {
  const mainUrl = pathToFileURL(
    resolve("packages/ohbaby-server/src/runtime/daemon/main.ts"),
  ).href;
  const script = `
    const { startDaemonServer } = await import(${JSON.stringify(mainUrl)});
    const options = JSON.parse(process.env.OHBABY_TEST_INPUT);
    const server = await startDaemonServer({ ...options, defaultPort: 0, packageVersion: "0.1.7" });
    process.stdout.write("OHBABY_TEST_READY " + JSON.stringify({ pid: process.pid, reused: server.reused, url: server.url }) + "\\n");
    if (!server.reused) {
      await new Promise((resolveStop) => {
        process.once("SIGTERM", () => {
          void server.stop().finally(resolveStop);
        });
      });
    }
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--eval", script], {
    env: {
      ...process.env,
      OHBABY_TEST_INPUT: JSON.stringify(input),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function waitForReady(
  child: ChildProcessWithoutNullStreams,
): Promise<ChildReady> {
  return new Promise((resolveReady, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for child serve: ${stderr}`));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const line = stdout
        .split("\n")
        .find((candidate) => candidate.startsWith("OHBABY_TEST_READY "));
      if (!line) {
        return;
      }
      clearTimeout(timeout);
      try {
        resolveReady(
          JSON.parse(line.slice("OHBABY_TEST_READY ".length)) as ChildReady,
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (stdout.trim().length === 0) {
        clearTimeout(timeout);
        reject(
          new Error(
            `Child serve exited before ready (code ${String(code)}): ${stderr}`,
          ),
        );
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for child process to exit"));
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

describe("global single serve across real processes", () => {
  it("reuses the first listener when started from another repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-real-global-serve-"));
    cleanupDirectories.push(root);
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await mkdir(join(repoA, ".git"), { recursive: true });
    await mkdir(join(repoB, ".git"), { recursive: true });
    const common = {
      dbPath: join(root, "agent.db"),
      homeDirectory: join(root, "home"),
    };

    const firstChild = spawnServe({ ...common, workdir: repoA });
    const first = await waitForReady(firstChild);
    expect(first.reused).toBe(false);

    const secondChild = spawnServe({ ...common, workdir: repoB });
    const second = await waitForReady(secondChild);
    await waitForExit(secondChild);

    expect(second.reused).toBe(true);
    expect(second.pid).not.toBe(first.pid);
    expect(new URL(second.url).origin).toBe(new URL(first.url).origin);
    expect(new URL(second.url).hash).toContain("directory=");
    expect(firstChild.exitCode).toBeNull();

    firstChild.kill("SIGTERM");
    await waitForExit(firstChild);
  }, 20_000);
});
