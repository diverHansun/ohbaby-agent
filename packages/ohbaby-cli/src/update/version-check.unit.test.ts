import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readAutoUpdate, setAutoUpdate } from "./settings.js";
import {
  fetchLatestVersion,
  readUpdateNotice,
  refreshVersionCacheInBackground,
  writeVersionCache,
} from "./version-check.js";

let ohbabyHome: string;
let server: Server | undefined;

beforeEach(async () => {
  ohbabyHome = await mkdtemp(join(tmpdir(), "ohbaby-check-"));
});

afterEach(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) =>
      server?.close(() => {
        resolve();
      }),
    );
  server = undefined;
  vi.restoreAllMocks();
  await rm(ohbabyHome, { recursive: true, force: true });
});

it("uses exact semver ordering, keeps prereleases out of stable startup notices, and tolerates corrupt caches", async () => {
  const stable = { ohbabyHome, currentVersion: "0.1.9", env: {} };
  expect(readUpdateNotice(stable)).toBeUndefined();
  await writeVersionCache(ohbabyHome, "0.1.10-beta.2");
  expect(readUpdateNotice(stable)).toBeUndefined();
  expect(
    readUpdateNotice({ ...stable, currentVersion: "0.1.10-beta.1" })
      ?.latestVersion,
  ).toBe("0.1.10-beta.2");
  await writeVersionCache(ohbabyHome, "0.1.10");
  expect(readUpdateNotice(stable)?.message).toContain("ohbaby update");
  expect(
    readUpdateNotice({ ...stable, currentVersion: "0.1.10" }),
  ).toBeUndefined();
  expect(
    readUpdateNotice({ ...stable, currentVersion: "0.2.0" }),
  ).toBeUndefined();
  expect(
    readUpdateNotice({ ...stable, env: { OHBABY_NO_UPDATE_CHECK: "1" } }),
  ).toBeUndefined();
  await writeFile(join(ohbabyHome, "update", "check.json"), "{");
  expect(readUpdateNotice(stable)).toBeUndefined();
});

it("refreshes a stale cache through the registry, respects opt-out and keeps settings", async () => {
  let requests = 0;
  server = createServer((request, response) => {
    requests++;
    expect(request.url).toBe("/mirror/ohbaby-cli/latest");
    response.end('{"version":"0.1.20"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const env = {
    npm_config_registry: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mirror/`,
  };
  const cached = join(ohbabyHome, "update", "check.json");
  expect(readAutoUpdate(ohbabyHome)).toBe(false);
  await setAutoUpdate(ohbabyHome, true);
  await writeFile(cached, '{"checkedAt":0,"latestVersion":"0.1.19"}');
  refreshVersionCacheInBackground({
    ohbabyHome,
    env: { ...env, OHBABY_NO_UPDATE_CHECK: "1" },
  });
  expect(requests).toBe(0);
  refreshVersionCacheInBackground({ ohbabyHome, env });
  await vi.waitFor(async () => {
    expect(await readFile(cached, "utf8")).toContain("0.1.20");
  });
  refreshVersionCacheInBackground({ ohbabyHome, env });
  expect(requests).toBe(1);
  expect(readAutoUpdate(ohbabyHome)).toBe(true);
  await setAutoUpdate(ohbabyHome, false);
  expect(readAutoUpdate(ohbabyHome)).toBe(false);
  await writeFile(join(ohbabyHome, "update", "settings.json"), "bad");
  expect(readAutoUpdate(ohbabyHome)).toBe(false);
});

it("reports a registry failure without accepting arbitrary version strings", async () => {
  let status = 500;
  server = createServer((_request, response) => {
    response.writeHead(status);
    response.end('{"version":"latest"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const env = {
    npm_config_registry: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
  };
  await expect(fetchLatestVersion(env)).rejects.toThrow("HTTP 500");
  status = 200;
  await expect(fetchLatestVersion(env)).rejects.toThrow("valid version");
});
