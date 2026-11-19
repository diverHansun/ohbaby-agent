import { once } from "node:events";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runUpgradePreflight,
  type UpgradePreflightOptions,
} from "./preflight.js";
import * as windowsProcesses from "./windows-processes.js";

const { resolveOhbabyHome } =
  await vi.importActual<typeof import("ohbaby-agent")>("ohbaby-agent");
const { inspectDaemonForMaintenance, stopDaemonFromState } =
  await vi.importActual<typeof import("ohbaby-server")>("ohbaby-server");

const deadPid = 2_000_000_000;
const currentPid = process.pid;
const pidToken = "original";
let home: string;
let daemon: string;

function preflight(overrides: Partial<UpgradePreflightOptions> = {}) {
  return runUpgradePreflight(
    {
      installMethod: { kind: "script", installDir: join(home, "install") },
      env: { ...process.env, OHBABY_HOME: home },
      ...overrides,
    },
    { resolveOhbabyHome, inspectDaemonForMaintenance, stopDaemonFromState },
  );
}

async function writeDaemonState(
  pid: number,
  token = pidToken,
  endpoint = { host: "127.0.0.1", port: 40409 },
): Promise<void> {
  await writeFile(
    join(daemon, "daemon-state.json"),
    JSON.stringify({
      pid,
      pidToken: token,
      status: "running",
      updatedAt: 1,
      ...endpoint,
      authToken: "service-auth",
    }),
  );
}

async function writeLock(pid: number, token = pidToken) {
  await writeFile(
    join(daemon, "daemon.pid"),
    JSON.stringify({ pid, token, startedAt: 1 }),
  );
}

async function writeReport(
  name: string,
  token = pidToken,
  status = "confirmed",
) {
  await writeFile(
    join(daemon, name),
    JSON.stringify({
      pid: deadPid,
      pidToken: token,
      recordedAt: 2,
      cleanup: { status, errors: [] },
    }),
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ohbaby-preflight-"));
  daemon = join(home, "server");
  await mkdir(daemon);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe("upgrade preflight", () => {
  it("allows an installation without a daemon identity", async () => {
    expect(await preflight()).toEqual({ ok: true, stoppedDaemon: false });
  });

  it("refuses an owner lock without state and a mismatched state", async () => {
    await writeLock(currentPid);
    expect(await preflight()).toMatchObject({ ok: false });
    await writeDaemonState(currentPid, "different");
    expect(await preflight()).toMatchObject({ ok: false });
  });

  it.each(["daemon-shutdown.json", "daemon-state.json.shutdown-original.json"])(
    "requires a matching confirmed cleanup report from %s even on retry",
    async (name) => {
      await writeDaemonState(deadPid);
      expect(await preflight()).toMatchObject({ ok: false });
      await writeReport(name, "different");
      expect(await preflight()).toMatchObject({ ok: false });
      await writeReport(name, pidToken, "unconfirmed");
      expect(await preflight()).toMatchObject({ ok: false });
      await writeReport(name);
      expect(await preflight()).toEqual({ ok: true, stoppedDaemon: false });
      await writeLock(currentPid, "successor");
      expect(await preflight()).toMatchObject({ ok: false });
    },
  );

  it("checks Windows process ownership only for npm installations", async () => {
    const list = vi
      .spyOn(windowsProcesses, "findWindowsInstallBlockers")
      .mockResolvedValue([71]);
    await writeDaemonState(currentPid);
    await writeLock(currentPid);
    const npm = { kind: "npm" as const, prefix: home };
    expect(
      await preflight({ platform: "win32", installMethod: npm }),
    ).toMatchObject({
      ok: false,
      reasons: [expect.stringContaining("PID 71")],
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ OHBABY_HOME: home }),
      currentPid,
    );
    list.mockClear();

    await Promise.all([
      rm(join(daemon, "daemon.pid")),
      rm(join(daemon, "daemon-state.json")),
    ]);
    await preflight({ platform: "linux", installMethod: npm });
    await preflight({ platform: "win32" });
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects a daemon that starts after the first inspection", async () => {
    vi.spyOn(windowsProcesses, "findWindowsInstallBlockers").mockImplementation(
      async () => {
        await writeDaemonState(currentPid, "successor");
        await writeLock(currentPid, "successor");
        return [];
      },
    );
    expect(
      await preflight({
        platform: "win32",
        installMethod: { kind: "npm", prefix: home },
      }),
    ).toMatchObject({
      ok: false,
      reasons: [expect.stringContaining("daemon changed")],
    });
  });

  it("does not send credentials to a non-local state address", async () => {
    await writeDaemonState(currentPid, pidToken, {
      host: "192.0.2.14",
      port: 40409,
    });
    await writeLock(currentPid);
    const result = await preflight();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reasons.join("\n")).toContain(
        "listening on a local address",
      );
  });

  for (const { status, host, bind, authority } of [
    { status: 409, host: "0.0.0.0", bind: "127.0.0.1", authority: "127.0.0.1" },
    { status: 404, host: "0.0.0.0", bind: "127.0.0.1", authority: "127.0.0.1" },
    { status: 404, host: "[::]", bind: "::1", authority: "[::1]" },
  ]) {
    it(`handles HTTP ${String(status)} directly with ${host} mapped to loopback`, async (context) => {
      const received = vi.fn();
      const server = http.createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
        });
        request.on("end", () => {
          received(
            request.url,
            request.headers.host,
            request.headers.authorization,
            body,
          );
          response.writeHead(status, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ reasons: ["Active prompt request-1"] }),
          );
        });
      });
      server.listen(0, bind);
      try {
        await once(server, "listening");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          bind === "::1" &&
          (code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL")
        ) {
          context.skip();
          return;
        }
        throw error;
      }
      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Expected a TCP listener");
        await writeDaemonState(currentPid, pidToken, {
          host,
          port: address.port,
        });
        await writeLock(currentPid);
        const fetch = vi.fn(() =>
          Promise.resolve(new Response(null, { status: 404 })),
        );
        vi.stubGlobal("fetch", fetch);
        const globalConnection = vi
          .spyOn(http.globalAgent, "createConnection")
          .mockImplementation(() => {
            throw new Error("Global HTTP transport must not be used");
          });

        const result = await preflight();
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reasons.join("\n")).toContain(
            status === 404 ? "ohbaby serve stop" : "Active prompt request-1",
          );
        }
        expect(fetch).not.toHaveBeenCalled();
        expect(globalConnection).not.toHaveBeenCalled();
        expect(received).toHaveBeenCalledTimes(1);
        expect(received).toHaveBeenCalledWith(
          "/api/shutdown/idle",
          `${authority}:${String(address.port)}`,
          "Bearer service-auth",
          JSON.stringify({ pidToken }),
        );
      } finally {
        const closed = once(server, "close");
        server.close();
        await closed;
      }
    });
  }
});
