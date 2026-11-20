import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectDaemonForMaintenance, stopDaemonFromState } from "./stop.js";
import { resolveDaemonScope } from "./scope.js";

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

it.each([
  { fixed: "matching", legacy: "wrong-pid", cleanup: "confirmed" },
  { fixed: "replacement", legacy: "missing", cleanup: "unknown" },
  { fixed: "replacement", legacy: "matching", cleanup: "confirmed" },
  { fixed: "invalid", legacy: "matching", cleanup: "confirmed" },
  { fixed: "missing", legacy: "wrong-pid", cleanup: "unknown" },
  { fixed: "unconfirmed", legacy: "matching", cleanup: "unconfirmed" },
])(
  "reads shutdown evidence: $fixed / $legacy",
  async ({ fixed, legacy, cleanup }) => {
    const f = await fixture();
    const writeReport = async (
      path: string,
      variant: string,
    ): Promise<void> => {
      if (variant === "missing") return;
      await writeFile(
        path,
        variant === "invalid"
          ? "{"
          : JSON.stringify({
              pid: variant === "wrong-pid" ? 456 : 123,
              pidToken: variant === "replacement" ? "replacement" : "original",
              recordedAt: 2,
              cleanup: {
                status: variant === "unconfirmed" ? "unconfirmed" : "confirmed",
                errors: [],
              },
            }),
      );
    };
    await writeReport(
      join(dirname(f.stateFilePath), "daemon-shutdown.json"),
      fixed,
    );
    await writeReport(`${f.stateFilePath}.shutdown-original.json`, legacy);
    let checks = 0;
    await expect(
      stopDaemonFromState({
        ...f,
        observeProcess: () => (++checks === 1 ? "alive" : "dead"),
        requestShutdown: () => Promise.resolve(),
      }),
    ).resolves.toMatchObject({
      processExit: "confirmed",
      cleanup,
      target: { token: "original" },
    });
  },
);

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

describe.each(["stopped", "crashed"])(
  "a %s state whose PID was reused after the lock was released",
  (status) => {
    async function reusedPidFixture(): Promise<
      Awaited<ReturnType<typeof fixture>>
    > {
      const f = await fixture();
      await rm(f.pidFilePath);
      await writeFile(
        f.stateFilePath,
        JSON.stringify({
          pid: process.pid,
          pidToken: "original",
          status,
          updatedAt: 2,
        }),
      );
      return f;
    }

    it("is not signalled by serve stop", async () => {
      const f = await reusedPidFixture();
      const kill = vi.fn();
      await expect(
        stopDaemonFromState({ ...f, kill, observeProcess: () => "alive" }),
      ).resolves.toMatchObject({ processExit: "not-running" });
      expect(kill).not.toHaveBeenCalled();
    });

    it("passes the maintenance check with its matching cleanup report", async () => {
      const f = await reusedPidFixture();
      const withoutReport = await inspectDaemonForMaintenance(f);
      expect(withoutReport.kind).toBe("blocked");
      expect(withoutReport.kind === "blocked" && withoutReport.reason).toMatch(
        /^Cleanup/,
      );
      await writeFile(
        join(dirname(f.stateFilePath), "daemon-shutdown.json"),
        JSON.stringify({
          pid: process.pid,
          pidToken: "original",
          recordedAt: 2,
          cleanup: { status: "confirmed", errors: [] },
        }),
      );
      await expect(inspectDaemonForMaintenance(f)).resolves.toMatchObject({
        kind: "stopped",
        target: { pid: process.pid, token: "original" },
      });
    });
  },
);

it("still treats a live stopped daemon that holds its lock as unsettled", async () => {
  const f = await fixture();
  await writeFile(
    f.pidFilePath,
    JSON.stringify({ pid: process.pid, token: "original", startedAt: 1 }),
  );
  await writeFile(
    f.stateFilePath,
    JSON.stringify({
      pid: process.pid,
      pidToken: "original",
      status: "stopped",
      updatedAt: 2,
    }),
  );
  const result = await inspectDaemonForMaintenance(f);
  expect(result.kind).toBe("blocked");
  expect(result.kind === "blocked" && result.reason).toContain(
    "starting, stopping",
  );
});
