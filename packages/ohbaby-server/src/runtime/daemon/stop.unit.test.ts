import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { stopDaemonFromState } from "./stop.js";
import { resolveDaemonScope } from "./scope.js";
import { shutdownReportPath } from "./state-file.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(): Promise<{
  homeDirectory: string;
  workdir: string;
  stateFilePath: string;
  pidFilePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "stop-identity-"));
  roots.push(root);
  const options = { homeDirectory: root, workdir: root };
  const scope = await resolveDaemonScope(options);
  await mkdir(dirname(scope.pidFilePath), { recursive: true });
  await writeFile(
    scope.pidFilePath,
    JSON.stringify({ pid: 123, token: "original", startedAt: 1 }),
  );
  await writeFile(
    scope.stateFilePath,
    JSON.stringify({
      pid: 123,
      pidToken: "original",
      status: "running",
      updatedAt: 1,
      host: "127.0.0.1",
      port: 1234,
      authToken: "fixture",
    }),
  );
  return {
    ...options,
    pidFilePath: scope.pidFilePath,
    stateFilePath: scope.stateFilePath,
  };
}

it("does not signal an unverifiable live process or adopt a replacement token", async () => {
  const f = await fixture();
  const kill = vi.fn();
  await expect(
    stopDaemonFromState({ ...f, kill, observeProcess: () => "unknown" }),
  ).resolves.toMatchObject({ processExit: "unconfirmed" });
  await writeFile(
    f.pidFilePath,
    JSON.stringify({ pid: 123, token: "replacement", startedAt: 2 }),
  );
  await expect(
    stopDaemonFromState({ ...f, kill, observeProcess: () => "alive" }),
  ).resolves.toMatchObject({ processExit: "unconfirmed" });
  expect(kill).not.toHaveBeenCalled();
});

it("reports unknown cleanup when only a different token has a clean shutdown report", async () => {
  const f = await fixture();
  await writeFile(
    shutdownReportPath(f.stateFilePath, "replacement"),
    JSON.stringify({
      pid: 123,
      pidToken: "replacement",
      recordedAt: 2,
      cleanup: { status: "confirmed", errors: [] },
    }),
  );
  let checks = 0;
  await expect(
    stopDaemonFromState({
      ...f,
      observeProcess: () => (++checks === 1 ? "alive" : "dead"),
      requestShutdown: () => Promise.resolve(),
    }),
  ).resolves.toMatchObject({
    processExit: "confirmed",
    cleanup: "unknown",
    target: { token: "original" },
  });
});

it("does not report exit for an early stopped file while the original process is alive", async () => {
  const f = await fixture();
  const started = Date.now();
  const result = await stopDaemonFromState({
    ...f,
    timeoutMs: 40,
    pollMs: 5,
    observeProcess: () => "alive",
    requestShutdown: async () => {
      await writeFile(
        f.stateFilePath,
        JSON.stringify({
          pid: 123,
          pidToken: "original",
          status: "stopped",
          updatedAt: 2,
        }),
      );
    },
  });
  expect(result.processExit).toBe("unconfirmed");
  expect(Date.now() - started).toBeLessThan(160);
});

it("bounds a shutdown request whose transport ignores cancellation", async () => {
  const f = await fixture();
  const started = Date.now();
  const result = await stopDaemonFromState({
    ...f,
    timeoutMs: 35,
    observeProcess: () => "alive",
    requestShutdown: () => new Promise<void>(() => undefined),
  });
  expect(result.processExit).toBe("unconfirmed");
  expect(Date.now() - started).toBeLessThan(160);
}, 250);

it("does not classify existing malformed identity files as an absent daemon", async () => {
  const f = await fixture();
  await writeFile(f.stateFilePath, "{}");
  await writeFile(f.pidFilePath, "{}");
  await expect(stopDaemonFromState(f)).resolves.toMatchObject({
    processExit: "unconfirmed",
  });
});
