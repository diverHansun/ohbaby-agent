import http from "node:http";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGlobalDispatcher } from "undici";
import axios from "axios";
import { installSystemProxy } from "./index.js";
import type { SystemProxySettings } from "./system.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function listen(server: http.Server): Promise<number> {
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  );
  return (server.address() as net.AddressInfo).port;
}
const host =
  Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address ??
  "0.0.0.0";
async function proxy(): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    res.end("PROXY");
  });
  const tunnels = new Set<net.Socket>();
  server.on("connect", (req, client, head) => {
    hits.push(req.url ?? "");
    const target = new URL(`http://${req.url ?? ""}`);
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    tunnels.add(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => {
      upstream.destroy();
      tunnels.delete(upstream);
    });
  });
  const port = await listen(server);
  cleanups.push(() => {
    for (const socket of tunnels) socket.destroy();
    return Promise.resolve();
  });
  return { url: `http://127.0.0.1:${String(port)}`, hits };
}
function nodeGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        response.on("end", () => {
          resolve(body);
        });
        response.on("error", reject);
      })
      .on("error", reject);
  });
}
describe("owned global network transport", () => {
  it("applies loopback bypass before Axios rewrites an environment proxy target", async () => {
    const port = await listen(http.createServer((_req, res) => res.end("OK")));
    const recording = await proxy();
    const previous = {
      http_proxy: process.env.http_proxy,
      NO_PROXY: process.env.NO_PROXY,
      no_proxy: process.env.no_proxy,
    };
    process.env.NO_PROXY = "";
    process.env.no_proxy = "";
    process.env.http_proxy = recording.url;
    try {
      const installation = await installSystemProxy({
        env: { HTTP_PROXY: recording.url },
      });
      cleanups.push(() => installation.dispose());
      expect(
        (
          await axios.get<string>(`http://127.0.0.1:${String(port)}`, {
            timeout: 2000,
          })
        ).data,
      ).toBe("OK");
      expect(recording.hits).toHaveLength(0);
      await installation.dispose();
      expect(
        (
          await axios.get<string>(`http://127.0.0.1:${String(port)}`, {
            timeout: 2000,
          })
        ).data,
      ).toBe("PROXY");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
  it("snapshots env and serializes refreshes even when a read spans multiple ticks", async () => {
    vi.useFakeTimers();
    let finishRead: ((value: SystemProxySettings) => void) | undefined;
    const readSystem = vi
      .fn()
      .mockResolvedValueOnce({ source: "system" })
      .mockImplementation(
        () =>
          new Promise<SystemProxySettings>((resolve) => {
            finishRead = resolve;
          }),
      );
    const env: NodeJS.ProcessEnv = {};
    try {
      const installation = await installSystemProxy({
        env,
        readSystem,
        pollIntervalMs: 20,
      });
      cleanups.push(() => installation.dispose());
      env.HTTP_PROXY = "http://127.0.0.1:1";
      await vi.advanceTimersByTimeAsync(100);
      expect(readSystem).toHaveBeenCalledTimes(2);
      await installation.dispose();
      const next = await installSystemProxy({
        env: {},
        readSystem: () => Promise.resolve({ source: "system" }),
      });
      cleanups.push(() => next.dispose());
      const active = http.globalAgent;
      finishRead?.({ source: "system", httpProxy: "http://127.0.0.1:1" });
      await vi.advanceTimersByTimeAsync(100);
      expect(readSystem).toHaveBeenCalledTimes(2);
      expect(http.globalAgent).toBe(active);
    } finally {
      vi.useRealTimers();
    }
  });
  it("routes both fetch and node HTTP through refreshed settings, drains streams, restores globals", async () => {
    let finishStream: (() => void) | undefined;
    let finishNodeStream: (() => void) | undefined;
    const origin = http.createServer((req, res) => {
      if (req.url === "/stream") {
        res.write("first");
        finishStream = (): void => {
          res.end("last");
        };
      } else if (req.url === "/node-stream") {
        res.write("node-first");
        finishNodeStream = (): void => {
          res.end("node-last");
        };
      } else if (req.url === "/gzip") {
        res.setHeader("content-encoding", "gzip");
        res.setHeader("content-type", "application/json");
        res.end(gzipSync(JSON.stringify({ ok: true })));
      } else res.end("OK");
    });
    const port = await listen(origin);
    const url = `http://${host}:${String(port)}`;
    const a = await proxy();
    const b = await proxy();
    let settings: SystemProxySettings = { source: "system", httpProxy: a.url };
    const baselineHttp = http.globalAgent;
    const baselineFetch = getGlobalDispatcher();
    const status = vi.fn();
    const installation = await installSystemProxy({
      env: {},
      readSystem: () => Promise.resolve(settings),
      pollIntervalMs: 20,
      onStatus: status,
    });
    cleanups.push(() => installation.dispose());
    expect(await (await fetch(url)).text()).toBe("OK");
    expect(await nodeGet(url)).toBe("OK");
    expect(a.hits).toHaveLength(2);
    expect(await (await fetch(`${url}/gzip`)).json()).toEqual({ ok: true });
    const stream = await fetch(`${url}/stream`);
    const text = stream.text();
    const nodeStream = nodeGet(`${url}/node-stream`);
    await vi.waitFor(
      () => {
        expect(finishNodeStream).toBeDefined();
      },
      { interval: 10 },
    );
    settings = { source: "system", httpProxy: b.url };
    await vi.waitFor(
      () => {
        expect(status).toHaveBeenCalledTimes(2);
      },
      { interval: 10 },
    );
    expect(await (await fetch(url)).text()).toBe("OK");
    expect(await nodeGet(url)).toBe("OK");
    expect(b.hits).toHaveLength(2);
    finishStream?.();
    expect(await text).toBe("firstlast");
    finishNodeStream?.();
    expect(await nodeStream).toBe("node-firstnode-last");
    settings = { source: "system" };
    await vi.waitFor(
      () => {
        expect(status).toHaveBeenCalledTimes(3);
      },
      { interval: 10 },
    );
    expect(await (await fetch(url)).text()).toBe("OK");
    expect(await nodeGet(url)).toBe("OK");
    expect(b.hits).toHaveLength(2);
    await installation.dispose();
    expect(http.globalAgent).toBe(baselineHttp);
    expect(getGlobalDispatcher()).toBe(baselineFetch);
  });
  it("blocks external traffic after reader failure, allows loopback, then recovers", async () => {
    const port = await listen(http.createServer((_req, res) => res.end("OK")));
    let broken = false;
    const status = vi.fn();
    const installation = await installSystemProxy({
      env: {},
      pollIntervalMs: 20,
      onStatus: status,
      readSystem: () =>
        broken
          ? Promise.reject(new Error("untrusted secret"))
          : Promise.resolve({ source: "system" }),
    });
    cleanups.push(() => installation.dispose());
    broken = true;
    await vi.waitFor(
      () => {
        expect(status).toHaveBeenCalledTimes(2);
      },
      { interval: 10 },
    );
    await expect(fetch(`http://${host}:${String(port)}`)).rejects.toThrow();
    await expect(
      nodeGet(`http://${host}:${String(port)}`),
    ).rejects.toMatchObject({ code: "OHBABY_PROXY_CONFIG" });
    expect(await (await fetch(`http://127.0.0.1:${String(port)}`)).text()).toBe(
      "OK",
    );
    expect(JSON.stringify(status.mock.calls)).not.toContain("secret");
    broken = false;
    await vi.waitFor(
      () => {
        expect(status).toHaveBeenCalledTimes(3);
      },
      { interval: 10 },
    );
    expect(await (await fetch(`http://${host}:${String(port)}`)).text()).toBe(
      "OK",
    );
  });
  it("honors env without reading OS and never falls back from a refused proxy", async () => {
    const origin = vi.fn(
      (_req: http.IncomingMessage, res: http.ServerResponse) => res.end("OK"),
    );
    const port = await listen(http.createServer(origin));
    const readSystem = vi.fn();
    const installation = await installSystemProxy({
      env: { HTTP_PROXY: "http://127.0.0.1:1" },
      readSystem,
    });
    cleanups.push(() => installation.dispose());
    await expect(fetch(`http://${host}:${String(port)}`)).rejects.toThrow();
    await expect(
      nodeGet(`http://${host}:${String(port)}`),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(origin).not.toHaveBeenCalled();
    expect(readSystem).not.toHaveBeenCalled();
  });
});
