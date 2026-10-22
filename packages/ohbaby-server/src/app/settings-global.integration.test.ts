import { createServer } from "node:http";
import { createWebTools } from "../../../ohbaby-agent/src/tools/web.js";
import {
  getSearchConfig,
  toSearchProviderConfig,
  _SearchConfigManager,
} from "../../../ohbaby-agent/src/config/tools/search/index.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createInProcessUiBackendClient,
  ensureDefaultWorkspaceDirectory,
} from "ohbaby-agent";
import { McpManager } from "../../../ohbaby-agent/src/mcp/core/manager.js";
import { createDaemonHttpServer } from "../runtime/daemon/server.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  LLMClientInstance,
} from "ohbaby-llm";
import type { UiEvent, UiSettingsMcpServerUpdate } from "ohbaby-sdk";

let root: string;
let home: string;
const backends = new Map<
  string,
  ReturnType<typeof createInProcessUiBackendClient>
>();
const requests = new Map<string, InterfaceProviderRequest[]>();
const runGates = new Map<string, { entered(): void; wait: Promise<void> }>();
const streams: { abort: AbortController; done: Promise<void> }[] = [];
let server: ReturnType<typeof createDaemonHttpServer> | undefined;
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error("Missing test fixture");
  return value;
}
async function json(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}
function backend(
  workdir: string,
): ReturnType<typeof createInProcessUiBackendClient> {
  const captured: InterfaceProviderRequest[] = [];
  requests.set(workdir, captured);
  const llmClient: LLMClientInstance = {
    config: {
      provider: "local",
      model: "fixed",
      baseUrl: "http://localhost.invalid/v1",
      interfaceProvider: "openai-compatible",
      maxTokens: 128,
      temperature: 0,
      modelProfiles: [
        {
          model: "fixed",
          contextWindowTokens: 128000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
    },
    provider: {
      id: "local",
      kind: "openai-compatible",
      client: {},
      isAbortError: () => false,
      streamResponse(
        request,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        const title = JSON.stringify(request).includes(
          "Write a short conversation title",
        );
        if (!title) captured.push(request);
        return Promise.resolve(
          (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            const gate = runGates.get(workdir);
            if (!title && gate) {
              gate.entered();
              await gate.wait;
            }
            yield { textDelta: "Done", finishReason: "stop" as const };
          })(),
        );
      },
    },
  };
  const result = createInProcessUiBackendClient({ workdir, llmClient });
  backends.set(workdir, result);
  return result;
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "settings-global-")));
  home = join(root, "global");
  vi.stubEnv("OHBABY_HOME", home);
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("USERPROFILE", join(root, "home"));
  vi.stubEnv("CODEX_HOME", join(root, "codex"));
  vi.stubEnv("TAVILY_API_KEY", undefined);
  await mkdir(join(root, "a"));
  server = createDaemonHttpServer({
    backend: backend(join(root, "a")),
    createWorkspaceBackend: backend,
    scopeRoot: join(root, "a"),
    port: 0,
    authToken: "test-token",
    packageVersion: "test-version",
    diagnosticsFile: join(root, "logs/daemon/log.jsonl"),
  });
  await server.start();
});
afterEach(async () => {
  for (const stream of streams.splice(0)) {
    stream.abort.abort();
    await stream.done;
  }
  runGates.clear();
  _SearchConfigManager.resetInstance();
  await server?.stop();
  server = undefined;
  await Promise.all([...backends.values()].map((b) => b.dispose()));
  backends.clear();
  requests.clear();
  await McpManager.disposeAll();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { force: true, recursive: true });
});
function request(
  route: string,
  method = "GET",
  body?: unknown,
  directory?: string,
): Promise<Response> {
  return fetch(`${required(server).url}/v1/settings/${route}`, {
    method,
    headers: {
      authorization: "Bearer test-token",
      ...(directory ? { "x-ohbaby-directory": directory } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function eventStream(
  directory: string,
  clientId: string,
): Promise<() => string> {
  const headers = {
    authorization: "Bearer test-token",
    "x-ohbaby-directory": directory,
    "content-type": "application/json",
  };
  const registration = await fetch(`${required(server).url}/v1/clients`, {
    method: "POST",
    headers,
    body: JSON.stringify({ clientId }),
  });
  expect(registration.status).toBe(200);
  const abort = new AbortController();
  const response = await fetch(`${required(server).url}/v1/events`, {
    headers: { ...headers, "x-ohbaby-client-id": clientId },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  const reader = required(response.body).getReader();
  let text = "";
  const done = (async (): Promise<void> => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value as Uint8Array);
      }
    } catch {
      /* abort closes the test stream */
    }
  })();
  streams.push({ abort, done });
  return () => text;
}
it("T8 T9 T10 exposes authorized header-free globals, field patches, safe errors and loaded overrides", async () => {
  expect(
    (await fetch(`${required(server).url}/v1/settings/about`)).status,
  ).toBe(401);
  const about = await request("about");
  expect(about.status).toBe(200);
  expect(await about.json()).toMatchObject({
    version: "test-version",
    ohbabyHome: home,
    defaultWorkspace: await ensureDefaultWorkspaceDirectory(),
    diagnosticsFile: join(root, "logs/daemon/log.jsonl"),
    logDirectory: join(root, "logs/daemon"),
  });
  expect(backends.size).toBe(1);
  const search = await request("search", "PUT", {
    apiKey: "search-sentinel",
    baseUrl: "http://127.0.0.1:1",
    defaults: { maxResults: 9, topic: "news" },
  });
  expect(search.status).toBe(200);
  expect(await search.text()).not.toContain("search-sentinel");
  await request("search", "PUT", { defaults: { timeout: 15 }, baseUrl: null });
  expect(await (await request("search")).json()).toMatchObject({
    provider: "tavily",
    apiKeyConfigured: true,
    defaults: { maxResults: 9, topic: "news", timeout: 15 },
  });
  await json(join(root, "a/.ohbaby/mcp/settings.json"), {
    mcpServers: { shared: { command: "node", enabled: false } },
  });
  const result = await request("mcp/servers/shared", "PUT", {
    transport: "stdio",
    command: "node",
    enabled: false,
    env: { set: { TOKEN: "env-sentinel" } },
  });
  expect(result.status).toBe(200);
  const responseBody: unknown = await result.json();
  expect(JSON.stringify(responseBody)).not.toContain("env-sentinel");
  expect(responseBody).toMatchObject({
    envKeys: ["TOKEN"],
    overriddenIn: [join(root, "a")],
  });
  const httpSave = await request("mcp/servers/headers", "PUT", {
    transport: "http",
    url: "http://localhost:1",
    enabled: false,
    headers: { set: { Authorization: "header-sentinel" } },
  });
  expect(httpSave.status).toBe(200);
  expect(await httpSave.text()).not.toContain("header-sentinel");
  const listed = await (await request("mcp/servers")).text();
  expect(listed).not.toMatch(/env-sentinel|header-sentinel/);
  expect((await request("mcp/servers/headers", "DELETE")).status).toBe(200);
  const before = await readFile(join(home, "mcp/settings.json"), "utf8");
  const invalid = await request("mcp/servers/shared", "PUT", {
    includeTools: ["secret-sentinel"],
    excludeTools: ["secret-sentinel"],
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).not.toContain("secret-sentinel");
  expect(await readFile(join(home, "mcp/settings.json"), "utf8")).toBe(before);
  expect((await request("mcp/servers/no-such", "DELETE")).status).toBe(404);
  expect((await request("mcp/servers/shared", "DELETE")).status).toBe(200);
  expect(await (await request("mcp/servers")).json()).toEqual({
    ok: true,
    servers: [],
  });
  expect((await request("mcp/status")).status).toBe(400);
  expect(
    (await request("mcp/status", "GET", undefined, join(root, "a"))).status,
  ).toBe(200);
  // First-use reconnect initializes only MCP, without requiring a model runtime.
  expect(
    (await request("mcp/reconnect", "POST", undefined, join(root, "a"))).status,
  ).toBe(200);
  const oversized = await request("search", "PUT", {
    apiKey: "x".repeat(1024 * 1024),
  });
  expect(oversized.status).toBe(413);
});
it("T13 T14 uses real stdio: save notifies A/B without reconnect, next rounds apply, C reads latest, and explicit reconnect waits for tools only in A", async () => {
  const a = join(root, "a");
  const b = join(root, "b");
  const c = join(root, "c");
  await mkdir(b);
  await mkdir(c);
  const fixture = join(root, "mcp.cjs");
  const connections = join(root, "connections");
  const gate = join(root, "release-tools");
  const entered = join(root, "listing");
  await writeFile(
    fixture,
    `const fs=require('node:fs'); const readline=require('node:readline');
const [log,version,gate,entered]=process.argv.slice(2); fs.appendFileSync(log,version+'\\n');
readline.createInterface({input:process.stdin}).on('line', async line=>{
 const request=JSON.parse(line); if(request.id===undefined)return;
 if(request.method==='tools/list' && gate) { fs.writeFileSync(entered,'ready'); while(!fs.existsSync(gate)) await new Promise(r=>setTimeout(r,5)); }
 const result=request.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:request.method==='tools/list'?{tools:[{name:version,description:'Tool '+version,inputSchema:{type:'object'}},{name:'filtered',inputSchema:{type:'object'}}]}:{};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});`,
  );
  const patch = (
    version: string,
    paused = false,
  ): UiSettingsMcpServerUpdate => ({
    transport: "stdio",
    command: process.execPath,
    args: [fixture, connections, version, ...(paused ? [gate, entered] : [])],
    excludeTools: ["filtered"],
    timeout: 5000,
  });
  expect(
    (await request("mcp/servers/tools", "PUT", patch("first"))).status,
  ).toBe(200);
  const daemon = required(server);
  if (!daemon.loadWorkspaceScopes) throw new Error("Expected workspace store");
  await daemon.loadWorkspaceScopes([b]);
  const streamA = await eventStream(a, "a-observer");
  const streamB = await eventStream(b, "b-observer");
  for (const directory of [a, b])
    expect(
      await (await request("mcp/status", "GET", undefined, directory)).json(),
    ).toMatchObject({
      servers: [{ toolCount: 1, tools: [{ mcpToolName: "first" }] }],
    });
  const eventsA: UiEvent[] = [];
  const eventsB: UiEvent[] = [];
  required(backends.get(a)).subscribeEvents((e) => {
    eventsA.push(e);
  });
  required(backends.get(b)).subscribeEvents((e) => {
    eventsB.push(e);
  });
  const count = async (): Promise<number> =>
    (await readFile(connections, "utf8")).trim().split("\n").length;
  expect(await count()).toBe(2);
  await request("mcp/servers/tools", "PUT", patch("second"));
  for (const events of [eventsA, eventsB])
    expect(events).toContainEqual({
      type: "settings.changed",
      domains: ["mcp"],
    });
  await vi.waitFor(() => {
    for (const text of [streamA(), streamB()]) {
      expect(text).toContain("settings.changed");
      expect(text).toContain('"domains":["mcp"]');
    }
  });
  for (const directory of [a, b])
    expect(
      await (await request("mcp/status", "GET", undefined, directory)).json(),
    ).toMatchObject({ servers: [{ tools: [{ mcpToolName: "first" }] }] });
  expect(await count()).toBe(2);
  for (const directory of [a, b]) {
    expect(
      (
        await required(backends.get(directory)).submitPromptAndWait(
          "List tools",
          {
            sessionId: directory === a ? "a-session" : "b-session",
          },
        )
      ).prompt.status,
    ).toBe("succeeded");
    expect(
      JSON.stringify(required(requests.get(directory)).at(-1)?.tools),
    ).toContain("second");
  }
  expect(await count()).toBe(4);
  expect((await request("mcp/status", "GET", undefined, c)).status).toBe(200);
  expect(await count()).toBe(5);
  await request("search", "PUT", { apiKey: "notified-key" });
  for (const events of [eventsA, eventsB]) {
    expect(events).toContainEqual({
      type: "settings.changed",
      domains: ["search"],
    });
    expect(events.some((e) => e.type === "model.invalidated")).toBe(false);
  }
  await required(backends.get(a)).notifySettingsChanged(["model"]);
  expect(eventsA.some((e) => e.type === "model.invalidated")).toBe(true);
  await vi.waitFor(() => {
    expect(streamA()).toContain("model.invalidated");
  });
  expect(streamB()).not.toContain("model.invalidated");
  await request("mcp/servers/tools", "PUT", patch("third", true));
  let returned = false;
  const reconnect = request("mcp/reconnect", "POST", undefined, a).then(
    (response) => {
      returned = true;
      return response;
    },
  );
  await vi.waitFor(async () => {
    expect(await readFile(entered, "utf8")).toBe("ready");
  });
  expect(returned).toBe(false);
  const beforeRequests = required(requests.get(a)).length;
  const prompt = required(backends.get(a)).submitPromptAndWait(
    "After reconnect",
    { sessionId: "a-session" },
  );
  await new Promise((r) => setTimeout(r, 30));
  expect(required(requests.get(a)).length).toBe(beforeRequests);
  await writeFile(gate, "go");
  const response = await reconnect;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    servers: [{ toolCount: 1, tools: [{ mcpToolName: "third" }] }],
  });
  expect((await prompt).prompt.status).toBe("succeeded");
  expect(JSON.stringify(required(requests.get(a)).at(-1)?.tools)).toContain(
    "third",
  );
  expect(await count()).toBe(6);
  expect(
    await (await request("mcp/status", "GET", undefined, b)).json(),
  ).toMatchObject({ servers: [{ tools: [{ mcpToolName: "second" }] }] });
  expect(await count()).toBe(6);
}, 20000);
it("T8 next real web_search request uses the newly saved URL, credentials and merged defaults", async () => {
  const observed: {
    url: string | undefined;
    authorization: string | undefined;
    body: unknown;
  }[] = [];
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      observed.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(body) as unknown,
      });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          query: "test",
          images: [],
          response_time: 0,
          request_id: "local",
          results: [
            {
              title: "Local result",
              url: "http://example.test",
              content: "result",
              score: 1,
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Expected local listener");
  const url = `http://127.0.0.1:${String(address.port)}`;
  try {
    const tool = required(
      createWebTools({
        loadConfig: async () => toSearchProviderConfig(await getSearchConfig()),
      }).find((t) => t.name === "web_search"),
    );
    const context = {
      callId: "search",
      messageId: "message",
      sessionId: "session",
      signal: new AbortController().signal,
    };
    expect(
      (
        await request("search", "PUT", {
          apiKey: "old-key",
          baseUrl: `${url}/first`,
          defaults: { maxResults: 3, topic: "news" },
        })
      ).status,
    ).toBe(200);
    await tool.execute({ query: "first" }, context);
    expect(
      (
        await request("search", "PUT", {
          apiKey: "new-key",
          baseUrl: `${url}/second`,
          defaults: { maxResults: 7 },
        })
      ).status,
    ).toBe(200);
    await tool.execute({ query: "second" }, context);
    expect(observed).toMatchObject([
      {
        url: "/first/search",
        authorization: "Bearer old-key",
        body: { query: "first", max_results: 3, topic: "news" },
      },
      {
        url: "/second/search",
        authorization: "Bearer new-key",
        body: { query: "second", max_results: 7, topic: "news" },
      },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});
it("T14 HTTP reconnect rejects an active turn with INSTANCE_BUSY then works after release", async () => {
  const a = join(root, "a");
  let enter!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  runGates.set(a, { entered: enter, wait });
  const running = required(backends.get(a)).submitPromptAndWait(
    "Hold this turn",
    { sessionId: "busy" },
  );
  await entered;
  try {
    const response = await request("mcp/reconnect", "POST", undefined, a);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "INSTANCE_BUSY" },
    });
  } finally {
    release();
    await running;
  }
  expect((await request("mcp/reconnect", "POST", undefined, a)).status).toBe(
    200,
  );
});
it("does not mount global settings without InstanceStore", async () => {
  const single = createDaemonHttpServer({
    backend: required(backends.get(join(root, "a"))),
    port: 0,
    authToken: "test-token",
  });
  await single.start();
  try {
    expect(
      (
        await fetch(`${single.url}/v1/settings/about`, {
          headers: { authorization: "Bearer test-token" },
        })
      ).status,
    ).toBe(404);
  } finally {
    await single.stop();
  }
});
it.each([
  "https://credential-sentinel@example.test/search",
  "https://example.test/search?%74oken=credential%2Dsentinel",
])(
  "does not expose parsed URL credentials in successful search/MCP PUT and GET responses for %s",
  async (url) => {
    const searchSave = await request("search", "PUT", { baseUrl: url });
    const mcpSave = await request("mcp/servers/url", "PUT", {
      transport: "http",
      url,
      enabled: false,
    });
    const searchRead = await request("search");
    const mcpRead = await request("mcp/servers");
    for (const response of [searchSave, mcpSave, searchRead, mcpRead]) {
      expect(response.status).toBe(200);
      expect(await response.text()).not.toMatch(/credential(?:-|%2D)sentinel/i);
    }
    const savedSearch: unknown = JSON.parse(
      await readFile(join(home, "tools/search.json"), "utf8"),
    );
    const savedMcp: unknown = JSON.parse(
      await readFile(join(home, "mcp/settings.json"), "utf8"),
    );
    expect(savedSearch).toMatchObject({ baseUrl: url });
    expect(savedMcp).toMatchObject({ mcpServers: { url: { url } } });
  },
);
it.each([
  "https://example.test/mcp?auth=prefix-header-sentinel-suffix",
  "https://example.test/mcp?auth=prefix-header%2Dsentinel-suffix",
])(
  "masks known header credentials in successful MCP PUT/GET URL responses for %s",
  async (url) => {
    const savedResponse = await request("mcp/servers/known-secret", "PUT", {
      transport: "http",
      url,
      enabled: false,
      headers: { set: { "X-Api-Key": "header-sentinel" } },
    });
    for (const response of [savedResponse, await request("mcp/servers")]) {
      expect(response.status).toBe(200);
      expect(await response.text()).not.toMatch(/header(?:-|%2D)sentinel/i);
    }
    const saved: unknown = JSON.parse(
      await readFile(join(home, "mcp/settings.json"), "utf8"),
    );
    expect(saved).toMatchObject({
      mcpServers: {
        "known-secret": { url, headers: { "X-Api-Key": "header-sentinel" } },
      },
    });
  },
);
