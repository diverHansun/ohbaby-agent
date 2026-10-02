import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { tavily } from "@tavily/core";
import { installSystemProxy } from "../index.js";

// This certificate/key are public test fixtures, trusted only in this child.
const origin = https.createServer(
  {
    cert: readFileSync(new URL("./test-cert.pem", import.meta.url)),
    key: readFileSync(new URL("./test-key.pem", import.meta.url)),
  },
  (req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/search"
          ? { query: "test", results: [], images: [] }
          : { id: "test", object: "list", data: [], content: [] },
      ),
    );
  },
);
origin.listen(0, "127.0.0.1");
await once(origin, "listening");
const port = (origin.address() as net.AddressInfo).port;
const baseURL = `https://network.test:${String(port)}`;
let httpOriginHits = 0;
const httpOrigin = http.createServer((req, res) => {
  httpOriginHits++;
  req.resume();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ query: "test", results: [], images: [] }));
});
httpOrigin.listen(0, "0.0.0.0");
await once(httpOrigin, "listening");
const httpPort = (httpOrigin.address() as net.AddressInfo).port;
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
assert.ok(lanAddress, "CIDR integration requires a nonloopback IPv4 interface");
const sockets = new Set<Duplex>();
const targets: string[] = [];
const proxy = http.createServer((req, res) => {
  // Axios rewrites HTTPS requests to an HTTP absolute URL when env proxy is set.
  // Forward it here, recording exactly one proxy visit.
  targets.push(req.url ?? "");
  if (new URL(req.url ?? "").protocol === "http:") {
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ query: "test", results: [], images: [] }));
    return;
  }
  const request = https.request(
    `https://127.0.0.1:${String(port)}${new URL(req.url ?? "").pathname}`,
    {
      method: req.method,
      headers: { ...req.headers, host: `network.test:${String(port)}` },
      servername: "network.test",
      agent: new https.Agent({ proxyEnv: {} }),
    },
    (response) => {
      res.writeHead(response.statusCode ?? 500, response.headers);
      response.pipe(res);
    },
  );
  request.on("error", (error) => {
    res.destroy(error);
  });
  req.pipe(request);
});
proxy.on("connect", (req, client, head) => {
  targets.push(req.url ?? "");
  assert.equal(req.url, `network.test:${String(port)}`);
  const upstream = net.connect(port, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  sockets.add(upstream);
  sockets.add(client);
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const proxyURL = `http://127.0.0.1:${String((proxy.address() as net.AddressInfo).port)}`;
let installation = await installSystemProxy({
  env: {},
  readSystem: () => Promise.resolve({ source: "system", httpsProxy: proxyURL }),
});
try {
  await new Promise<void>((resolve, reject) =>
    https
      .get(baseURL, (response) => {
        response.resume();
        response.on("end", resolve);
      })
      .on("error", reject),
  );
  await tavily({ apiKey: "test", apiBaseURL: baseURL }).search("test");
  await new OpenAI({ apiKey: "test", baseURL, maxRetries: 0 }).models.list();
  await new Anthropic({
    apiKey: "test",
    baseURL,
    maxRetries: 0,
  }).messages.create({
    model: "test",
    max_tokens: 1,
    messages: [{ role: "user", content: "test" }],
  });
  const system = targets.length;
  await installation.dispose();
  process.env.HTTPS_PROXY = proxyURL;
  installation = await installSystemProxy({ env: process.env });
  await tavily({ apiKey: "test", apiBaseURL: baseURL }).search("test");
  const environment = targets.length - system;
  await installation.dispose();
  delete process.env.HTTPS_PROXY;
  // An explicitly supplied Tavily agent owns its route, overriding CLI policy.
  installation = await installSystemProxy({
    env: { HTTPS_PROXY: "http://127.0.0.1:1" },
  });
  await tavily({
    apiKey: "test",
    apiBaseURL: baseURL,
    proxies: { https: proxyURL },
  }).search("test");
  const explicit = targets.length - system - environment;
  await installation.dispose();
  installation = await installSystemProxy({
    env: { HTTPS_PROXY: proxyURL, NO_PROXY: "network.test" },
  });
  const beforeDirect = targets.length;
  const directOptions: https.RequestOptions = {
    family: 4,
    lookup: (_hostname, _options, callback) => {
      callback(null, "127.0.0.1", 4);
    },
  };
  await new Promise<void>((resolve, reject) =>
    https
      .get(baseURL, directOptions, (response) => {
        response.resume();
        response.on("end", resolve);
      })
      .on("error", reject),
  );
  assert.equal(
    targets.length,
    beforeDirect,
    "NO_PROXY must bypass the proxy for external HTTPS",
  );
  await new Promise<void>((resolve, reject) =>
    https
      .get(baseURL, { ...directOptions, agent: false }, (response) => {
        response.resume();
        response.on("end", resolve);
      })
      .on("error", reject),
  );
  assert.equal(
    targets.length,
    beforeDirect,
    "agent:false HTTPS must retain NO_PROXY",
  );
  await installation.dispose();
  process.env.HTTP_PROXY = proxyURL;
  installation = await installSystemProxy({ env: { HTTP_PROXY: proxyURL } });
  const beforeLoopback = targets.length;
  await tavily({
    apiKey: "test",
    apiBaseURL: `http://127.0.0.1:${String(httpPort)}`,
  }).search("test");
  assert.equal(httpOriginHits, 1, "Tavily loopback must reach the HTTP origin");
  assert.equal(
    targets.length,
    beforeLoopback,
    "Tavily loopback must bypass configured env proxy",
  );
  await installation.dispose();
  process.env.NO_PROXY = `${lanAddress}/32`;
  installation = await installSystemProxy({
    env: { HTTP_PROXY: proxyURL, NO_PROXY: process.env.NO_PROXY },
  });
  await tavily({
    apiKey: "test",
    apiBaseURL: `http://${lanAddress}:${String(httpPort)}`,
  }).search("test");
  assert.equal(
    httpOriginHits,
    2,
    "Tavily CIDR bypass must reach the HTTP origin",
  );
  assert.equal(
    targets.length,
    beforeLoopback,
    "Tavily must honor IP CIDR NO_PROXY",
  );
  await installation.dispose();
  delete process.env.HTTP_PROXY;
  delete process.env.NO_PROXY;
  process.env.HTTPS_PROXY = proxyURL;
  installation = await installSystemProxy({ env: { HTTPS_PROXY: proxyURL } });
  process.env.HTTPS_PROXY = "http://127.0.0.1:1";
  await tavily({ apiKey: "test", apiBaseURL: baseURL }).search("test");
  assert.equal(
    targets.length,
    beforeLoopback + 1,
    "SDK must use installed settings rather than newly mutated env",
  );
  await installation.dispose();
  process.env.HTTPS_PROXY = proxyURL;
  const beforeRestored = targets.length;
  await tavily({ apiKey: "test", apiBaseURL: baseURL }).search("test");
  assert.equal(targets.length, beforeRestored + 1);
  assert.equal(
    targets.at(-1),
    `${baseURL}/search`,
    "dispose must restore Axios automatic absolute-form env proxy routing",
  );
  // Child harness reports assertions to its parent, never production output.
  // eslint-disable-next-line no-restricted-properties
  process.stdout.write(
    JSON.stringify({
      system,
      environment,
      explicit,
      noProxy: true,
      agentFalse: true,
      loopback: true,
      cidr: true,
      snapshot: true,
      axiosRestored: true,
    }),
  );
} finally {
  await installation.dispose();
  for (const socket of sockets) socket.destroy();
  httpOrigin.closeAllConnections();
  httpOrigin.close();
  origin.closeAllConnections();
  origin.close();
  proxy.closeAllConnections();
  proxy.close();
}
