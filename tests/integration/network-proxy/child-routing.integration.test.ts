import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import { networkInterfaces, tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadTool } from "../../../packages/ohbaby-agent/src/tools/read.js";
import { createGlobTool } from "../../../packages/ohbaby-agent/src/tools/glob.js";
import { createGrepTool } from "../../../packages/ohbaby-agent/src/tools/grep.js";
import { createHostLocalEnvironment } from "../../../packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.js";
import { createBashTool } from "../../../packages/ohbaby-agent/src/tools/bash.js";
import { ShellJobRegistry } from "../../../packages/ohbaby-agent/src/tools/shell-job-registry.js";
import { Shell } from "../../../packages/ohbaby-agent/src/shell/index.js";
import type { ToolExecutionContext } from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import { McpClient } from "../../../packages/ohbaby-agent/src/mcp/core/client.js";
import {
  getProxyConfigurationSnapshot,
  installSystemProxy,
} from "../../../packages/ohbaby-agent/src/utils/network-proxy/index.js";
import type { SystemProxySettings } from "../../../packages/ohbaby-agent/src/utils/network-proxy/system.js";
import { readSystemProxy } from "../../../packages/ohbaby-agent/src/utils/network-proxy/system.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
const cert = fileURLToPath(
  new URL(
    "../../../packages/ohbaby-agent/src/utils/network-proxy/fixtures/test-cert.pem",
    import.meta.url,
  ),
);
const key = fileURLToPath(
  new URL(
    "../../../packages/ohbaby-agent/src/utils/network-proxy/fixtures/test-key.pem",
    import.meta.url,
  ),
);
const stdioFixture = fileURLToPath(
  new URL("./fixtures/stdio-server.mjs", import.meta.url),
);
const curl = process.platform === "win32" ? "curl.exe" : "curl";
const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";

async function listen(
  server: http.Server | https.Server,
  host = "127.0.0.1",
): Promise<number> {
  server.listen(0, host);
  await once(server, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return (server.address() as net.AddressInfo).port;
}
async function recordingProxy(
  tlsPort?: number,
): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];
  const httpPort = await listen(
    http.createServer((_request, response) => response.end("PROXY_HTTP")),
  );
  const proxy = http.createServer((request, response) => {
    hits.push(request.url ?? "");
    response.end("PROXY_HTTP");
  });
  const sockets = new Set<Duplex>();
  proxy.on("connect", (request, client, head) => {
    hits.push(`CONNECT ${request.url ?? ""}`);
    const upstream = net.connect(
      tlsPort !== undefined && request.url?.endsWith(`:${String(tlsPort)}`)
        ? tlsPort
        : httpPort,
      "127.0.0.1",
      () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      },
    );
    sockets.add(client);
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  const port = await listen(proxy);
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
  });
  return { url: `http://127.0.0.1:${String(port)}`, hits };
}
function context(
  sessionId = "parent",
  env: Record<string, string> = {},
): ToolExecutionContext {
  return {
    sessionId,
    messageId: "message",
    callId: `call-${sessionId}`,
    signal: new AbortController().signal,
    owner: {
      sessionId,
      rootSessionId: "parent",
      executionId: sessionId === "parent" ? undefined : "delegation-1",
      messageId: "message",
      callId: `call-${sessionId}`,
    },
    resolveCommandContext: () => ({ cwd: tmpdir(), env, kind: "host-local" }),
  };
}
function bash(registry?: ShellJobRegistry): ReturnType<typeof createBashTool> {
  return createBashTool({
    registry,
    shell: {
      acceptable: () => shell,
      killTree: (child) => Shell.killTree(child),
    },
  });
}
function curlCommand(url: string, tls = false): string {
  return `${curl} --silent --show-error --fail --max-time 3 ${tls ? `--cacert "${cert}" ` : ""}"${url}"`;
}
function stdio(env: Record<string, string> = {}): McpClient {
  const client = new McpClient("fixture", {
    type: "stdio",
    command: process.execPath,
    args: [stdioFixture],
    env,
    enabled: true,
    timeout: 5000,
    trust: false,
  });
  cleanups.push(() => client.disconnect());
  return client;
}
async function probe(
  client: McpClient,
  url: string,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name: "probe", arguments: { url } });
  expect(result.isError).not.toBe(true);
  const text = result.content.find((entry) => entry.type === "text");
  if (!text || text.type !== "text") throw new Error("Missing fixture report");
  return JSON.parse(text.text) as Record<string, unknown>;
}

describe("installed proxy to real child network clients", () => {
  it("routes Node HTTP/HTTPS, parent Shell, delegated Shell and stdio through HTTP/CONNECT", async () => {
    const origin = https.createServer(
      { cert: readFileSync(cert), key: readFileSync(key) },
      (_request, response) => response.end("TLS_ORIGIN"),
    );
    const tlsPort = await listen(origin);
    const proxy = await recordingProxy(tlsPort);
    const installation = await installSystemProxy({
      env: {},
      readSystem: () =>
        Promise.resolve({
          source: "system",
          httpProxy: proxy.url,
          httpsProxy: proxy.url,
        }),
    });
    cleanups.push(() => installation.dispose());
    const httpUrl = "http://network.test/main";
    const httpsUrl = `https://network.test:${String(tlsPort)}/tls`;
    const nodeGet = (url: string, secure = false): Promise<string> =>
      new Promise((resolve, reject) => {
        const module = secure ? https : http;
        module
          .get(url, secure ? { ca: readFileSync(cert) } : {}, (response) => {
            let body = "";
            response.on("data", (chunk: Buffer) => {
              body += chunk.toString();
            });
            response.on("end", () => resolve(body));
          })
          .on("error", reject);
      });
    expect(await nodeGet(httpUrl)).toBe("PROXY_HTTP");
    expect(await nodeGet(httpsUrl, true)).toBe("TLS_ORIGIN");
    for (const session of ["parent", "subagent"]) {
      expect(
        (
          await bash().execute(
            { command: curlCommand(httpUrl) },
            context(session),
          )
        ).output,
      ).toContain("PROXY_HTTP");
      expect(
        (
          await bash().execute(
            { command: curlCommand(httpsUrl, true) },
            context(session),
          )
        ).output,
      ).toContain("TLS_ORIGIN");
    }
    const client = stdio({ TEST_CA: cert, MCP_ALLOWED: "yes" });
    await client.connect();
    expect((await probe(client, httpUrl)).body).toBe("PROXY_HTTP");
    expect((await probe(client, httpsUrl)).body).toBe("TLS_ORIGIN");
    expect(proxy.hits.filter((hit) => hit.startsWith("http://"))).toHaveLength(
      3,
    );
    expect(
      proxy.hits.filter(
        (hit) => hit === `CONNECT network.test:${String(tlsPort)}`,
      ),
    ).toHaveLength(4);
    expect(
      proxy.hits.filter((hit) => hit === "CONNECT network.test:80"),
    ).toHaveLength(1);
  });

  it("refreshes new Shell/stdin processes without mutating parent env and keeps background env", async () => {
    const a = await recordingProxy();
    const b = await recordingProxy();
    let settings: SystemProxySettings = { source: "system", httpProxy: a.url };
    const baseline = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      http_proxy: process.env.http_proxy,
    };
    const installation = await installSystemProxy({
      env: {},
      pollIntervalMs: 20,
      readSystem: () => Promise.resolve(settings),
    });
    cleanups.push(() => installation.dispose());
    const registry = new ShellJobRegistry({
      killTree: (child) => Shell.killTree(child),
    });
    const tool = bash(registry);
    const background = await tool.execute(
      {
        command:
          process.platform === "win32"
            ? `Start-Sleep -Milliseconds 200; ${curlCommand("http://network.test/background")}`
            : `"${process.execPath}" -e "setTimeout(() => {}, 200)" && ${curlCommand("http://network.test/background")}`,
        run_in_background: true,
      },
      context(),
    );
    const jobId = String(background.metadata?.jobId);
    const client = stdio();
    await client.connect();
    expect((await probe(client, "http://network.test/first")).body).toBe(
      "PROXY_HTTP",
    );
    settings = { source: "system", httpProxy: b.url };
    await vi.waitFor(() =>
      expect(getProxyConfigurationSnapshot().system?.httpProxy).toBe(b.url),
    );
    expect(
      (
        await tool.execute(
          { command: curlCommand("http://network.test/new") },
          context("subagent"),
        )
      ).output,
    ).toContain("PROXY_HTTP");
    await client.disconnect();
    await client.connect();
    await probe(client, "http://network.test/reconnected");
    expect((await registry.waitForTerminal(jobId, "parent")).output).toContain(
      "PROXY_HTTP",
    );
    expect([...a.hits].sort()).toEqual([
      "http://network.test/background",
      "http://network.test/first",
    ]);
    expect(b.hits).toEqual([
      "http://network.test/new",
      "http://network.test/reconnected",
    ]);
    expect({
      HTTP_PROXY: process.env.HTTP_PROXY,
      http_proxy: process.env.http_proxy,
    }).toEqual(baseline);
  });

  it("stdio forwards the proxy whitelist and explicit config with SDK safe env, without unrelated secret", async () => {
    const original = process.env.OHBABY_MCP_SECRET;
    process.env.OHBABY_MCP_SECRET = "must-not-inherit";
    cleanups.push(async () => {
      if (original === undefined) delete process.env.OHBABY_MCP_SECRET;
      else process.env.OHBABY_MCP_SECRET = original;
    });
    const a = await recordingProxy();
    const b = await recordingProxy();
    const installation = await installSystemProxy({
      env: { http_proxy: a.url },
    });
    cleanups.push(() => installation.dispose());
    const client = stdio({ HTTP_PROXY: b.url, MCP_ALLOWED: "yes" });
    await client.connect();
    const report = await probe(client, "http://network.test/override");
    expect(report).toMatchObject({
      body: "PROXY_HTTP",
      secretVisible: false,
      allowed: "yes",
      safePath: true,
      safeHome: true,
      httpProxy: `${b.url}/`,
    });
    expect(a.hits).toHaveLength(0);
    expect(b.hits).toHaveLength(1);
  });

  it.each([
    "*.local",
    "<local>",
    "example.com",
    ".example.com",
    "host:80",
    "::1/128",
    "foo*bar.test",
  ])(
    "starts Shell/MCP with system bypass %s while retaining the proxy",
    async (rule) => {
      const proxy = await recordingProxy();
      const installation = await installSystemProxy({
        env: {},
        readSystem: () =>
          Promise.resolve({
            source: "system",
            httpProxy: proxy.url,
            bypass: [rule],
          }),
      });
      cleanups.push(() => installation.dispose());
      const registry = new ShellJobRegistry({
        killTree: (child) => Shell.killTree(child),
      });
      const result = await bash(registry).execute(
        { command: "echo started" },
        context(),
      );
      expect(result.output).toContain("started");
      expect(result.metadata?.exitCode).toBe(0);
      expect(registry.hasActiveWork()).toBe(false);
      const directory = await mkdtemp(join(tmpdir(), "ohbaby-proxy-"));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const marker = join(directory, "started");
      const client = stdio({ SPAWN_MARKER: marker });
      await client.connect();
      await access(marker);
      expect((await probe(client, "http://network.test/stdio")).body).toBe(
        "PROXY_HTTP",
      );
      expect(
        (
          await bash().execute(
            { command: curlCommand("http://network.test/shell") },
            context("subagent"),
          )
        ).output,
      ).toContain("PROXY_HTTP");
      expect(await (await fetch("http://network.test/node")).text()).toBe(
        "PROXY_HTTP",
      );
      expect(proxy.hits).toHaveLength(3);
    },
  );

  it("curl bypasses wildcard domain suffixes without bypassing unrelated hosts", async () => {
    const port = await listen(
      http.createServer((_request, response) => response.end("DIRECT")),
    );
    const proxy = await recordingProxy();
    const installation = await installSystemProxy({
      env: {},
      readSystem: async () => ({
        source: "system",
        httpProxy: proxy.url,
        bypass: ["*.local", "<local>"],
      }),
    });
    cleanups.push(() => installation.dispose());
    for (const host of [
      "printer.local",
      "printer.local.evil.test",
      "notlocal",
    ]) {
      const result = await bash().execute(
        {
          command: `${curlCommand(`http://${host}:${String(port)}`)} --resolve "${host}:${String(port)}:127.0.0.1"`,
        },
        context(),
      );
      expect(result.metadata?.exitCode).toBe(0);
      expect(result.output.trim()).toBe(
        host === "printer.local" ? "DIRECT" : "PROXY_HTTP",
      );
    }
    expect(proxy.hits).toHaveLength(2);
  });

  it.each(["read", "pac", "malformed"])(
    "fails cleanly on %s system configuration and permits explicit/all-bypass paths",
    async (kind) => {
      const readSystem =
        kind === "read"
          ? () => Promise.reject(new Error("hidden read credentials"))
          : () =>
              readSystemProxy({
                platform: "darwin",
                run: async () =>
                  kind === "pac"
                    ? "<dictionary> {\n ProxyAutoConfigEnable : 1\n}"
                    : "malformed",
              });
      const installation = await installSystemProxy({ env: {}, readSystem });
      cleanups.push(() => installation.dispose());
      const registry = new ShellJobRegistry({
        killTree: (child) => Shell.killTree(child),
      });
      await expect(
        bash(registry).execute({ command: "echo started" }, context()),
      ).rejects.toThrow(/Child process proxy configuration unavailable/);
      expect(registry.hasActiveWork()).toBe(false);
      const proxy = await recordingProxy();
      expect(
        (
          await bash().execute(
            { command: curlCommand("http://network.test/explicit") },
            context("parent", { HTTP_PROXY: proxy.url }),
          )
        ).output,
      ).toContain("PROXY_HTTP");
      const port = await listen(
        http.createServer((_request, response) => response.end("DIRECT")),
      );
      expect(
        (
          await bash().execute(
            { command: curlCommand(`http://127.0.0.1:${String(port)}`) },
            context("parent", { NO_PROXY: "*" }),
          )
        ).output,
      ).toContain("DIRECT");
      const client = stdio();
      await expect(client.connect()).rejects.toThrow(
        /configuration unavailable/,
      );
      expect(client.getStatus().status).toBe("failed");
      const healthy = stdio({ NO_PROXY: "*" });
      await healthy.connect();
      expect(
        (await probe(healthy, `http://127.0.0.1:${String(port)}`)).body,
      ).toBe("DIRECT");
    },
  );

  it("curl bypasses loopback and normalized IPv4 CIDR without contacting the configured proxy", async () => {
    const address = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    expect(address).toBeDefined();
    const direct = http.createServer((_request, response) =>
      response.end("DIRECT"),
    );
    const port = await listen(direct, "0.0.0.0");
    const proxy = await recordingProxy();
    const parts = address!.split(".");
    const abbreviated = `${parts[0]}.${parts[1]}/16`;
    const installation = await installSystemProxy({
      env: {},
      readSystem: () =>
        Promise.resolve({
          source: "system",
          httpProxy: proxy.url,
          bypass: [abbreviated],
        }),
    });
    cleanups.push(() => installation.dispose());
    for (const host of ["localhost", "127.0.0.1", address!])
      expect(
        (
          await bash().execute(
            { command: curlCommand(`http://${host}:${String(port)}`) },
            context(),
          )
        ).output,
      ).toContain("DIRECT");
    expect(proxy.hits).toHaveLength(0);
  });

  it("local Read/Glob/Grep including bundled rg remain available when network discovery fails", async () => {
    const installation = await installSystemProxy({
      env: {},
      readSystem: () => Promise.reject(new Error("unavailable")),
    });
    cleanups.push(() => installation.dispose());
    const directory = await mkdtemp(join(tmpdir(), "ohbaby-local-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, "note.txt"), "local needle\n");
    const ctx = {
      ...context(),
      environment: createHostLocalEnvironment(directory),
    };
    expect(
      (await createReadTool().execute({ file_path: "note.txt" }, ctx)).output,
    ).toContain("local needle");
    expect(
      (await createGlobTool().execute({ pattern: "*.txt" }, ctx)).output,
    ).toContain("note.txt");
    expect(
      (await createGrepTool().execute({ pattern: "needle" }, ctx)).output,
    ).toContain("local needle");
  });

  it("curl keeps other 127/8 addresses off the proxy even without a local OS alias", async () => {
    const proxy = await recordingProxy();
    const installation = await installSystemProxy({
      env: {},
      readSystem: () =>
        Promise.resolve({ source: "system", httpProxy: proxy.url }),
    });
    cleanups.push(() => installation.dispose());
    // macOS need not have 127.0.0.2 configured. A proxy visit would succeed;
    // the native direct connection failure and zero visits prove the bypass.
    const result = await bash().execute(
      {
        command: curlCommand("http://127.0.0.2:1/").replace(
          "--max-time 3",
          "--max-time 0.2",
        ),
      },
      context(),
    );
    expect(result.metadata?.exitCode).not.toBe(0);
    expect(proxy.hits).toHaveLength(0);
  });

  it("curl bypasses IPv6 ::1 with system proxies enabled", async () => {
    const port = await listen(
      http.createServer((_request, response) => response.end("IPV6_DIRECT")),
      "::1",
    );
    const proxy = await recordingProxy();
    const installation = await installSystemProxy({
      env: {},
      readSystem: () =>
        Promise.resolve({ source: "system", httpProxy: proxy.url }),
    });
    cleanups.push(() => installation.dispose());
    const result = await bash().execute(
      { command: curlCommand(`http://[::1]:${String(port)}`) },
      context(),
    );
    expect(result.output).toContain("IPV6_DIRECT");
    expect(proxy.hits).toHaveLength(0);
  });

  it("curl bypasses both dotted and hex mapped IPv6 literal loopback addresses", async () => {
    const port = await listen(
      http.createServer((_request, response) => response.end("DIRECT")),
    );
    const proxy = await recordingProxy();
    const installation = await installSystemProxy({
      env: {},
      readSystem: () =>
        Promise.resolve({
          source: "system",
          httpProxy: proxy.url,
          bypass: ["::ffff:127.0.0.1"],
        }),
    });
    cleanups.push(() => installation.dispose());
    for (const host of ["::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      const result = await bash().execute(
        { command: curlCommand(`http://[${host}]:${String(port)}`) },
        context(),
      );
      expect(result.output).toContain("DIRECT");
    }
    expect(proxy.hits).toHaveLength(0);
  });

  it("unreachable proxies fail in curl itself without falling back to a reachable origin", async () => {
    const address = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    expect(address).toBeDefined();
    let hits = 0;
    const port = await listen(
      http.createServer((_request, response) => {
        hits++;
        response.end("DIRECT");
      }),
      "0.0.0.0",
    );
    const installation = await installSystemProxy({
      env: { HTTP_PROXY: "http://127.0.0.1:1" },
    });
    cleanups.push(() => installation.dispose());
    const result = await bash().execute(
      { command: curlCommand(`http://${address!}:${String(port)}`) },
      context(),
    );
    expect(result.metadata?.exitCode).not.toBe(0);
    expect(hits).toBe(0);
    expect(result.output).toMatch(/curl|connect/i);
  });
});
