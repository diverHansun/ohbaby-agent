import { SkillLoader } from "../skill/loader.js";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  readFile,
  utimes,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
  LLMClientInstance,
} from "ohbaby-llm";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";
import { McpManager } from "../mcp/core/manager.js";
import type { McpServersConfig } from "../config/mcp/types.js";
import type { McpClientLike } from "../mcp/types.js";
import {
  getSearchConfig,
  _SearchConfigManager,
} from "../config/tools/search/index.js";
import * as compositionModule from "./ui-runtime/composition.js";
import type { UiEvent } from "ohbaby-sdk";
import { RuntimeSwitchPendingError } from "./ui-inprocess/runtime-controller.js";
import { coordinateModelConfig } from "../config/llm/config-coordination.js";

async function json(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

function recordingClient(
  requests: InterfaceProviderRequest[],
  gate?: { entered: () => void; wait: Promise<void> },
): LLMClientInstance {
  return {
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
        if (!title) requests.push(request);
        return Promise.resolve(
          (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            if (!title && gate) {
              gate.entered();
              await gate.wait;
            }
            yield {
              textDelta: title ? "Title" : "Done",
              finishReason: "stop" as const,
            };
          })(),
        );
      },
    },
  };
}

function localMcp(name: string, onDisconnect: () => void): McpClientLike {
  return {
    name,
    config: {
      type: "stdio",
      command: "fake",
      args: [],
      enabled: true,
      trust: false,
      timeout: 5000,
    },
    connect: () => Promise.resolve(),
    disconnect: (): Promise<void> => {
      onDisconnect();
      return Promise.resolve();
    },
    getStatus: () => ({ status: "connected", toolCount: 1 }),
    listTools: () =>
      Promise.resolve([
        {
          name: "echo",
          description: `Tool from ${name}`,
          inputSchema: { type: "object" },
        },
      ]),
    callTool: () =>
      Promise.resolve({ content: [{ type: "text", text: name }] }),
  };
}

describe("settings propagation through the shared production backend", () => {
  let root: string;
  let globalRoot: string;
  let skillRevision = 0;
  const clients: ReturnType<typeof createInProcessUiBackendClient>[] = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ohbaby-settings-refresh-"));
    globalRoot = join(root, "global");
    vi.stubEnv("OHBABY_HOME", globalRoot);
    vi.stubEnv("HOME", join(root, "home"));
    vi.stubEnv("USERPROFILE", join(root, "home"));
    vi.stubEnv("CODEX_HOME", join(root, "codex"));
    vi.stubEnv("TAVILY_API_KEY", "local-test-key");
    _SearchConfigManager.resetInstance();
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.dispose()));
    await McpManager.disposeAll();
    _SearchConfigManager.resetInstance();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  async function skill(
    directory: string,
    name: string,
    description: string,
    body = "Original body",
  ): Promise<string> {
    const file = join(directory, name, "SKILL.md");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    );
    // Deterministic signature changes even on coarse timestamp filesystems.
    const stamp = new Date(Date.now() + ++skillRevision * 1000);
    await utimes(file, stamp, stamp);
    return file;
  }
  function backend(
    workdir: string,
    requests: InterfaceProviderRequest[],
  ): ReturnType<typeof createInProcessUiBackendClient> {
    const client = createInProcessUiBackendClient({
      workdir,
      llmClient: recordingClient(requests),
    });
    clients.push(client);
    return client;
  }
  it("reloads a command-preloaded Skill registry against current settings before its first runtime", async () => {
    const workdir = join(root, "preloaded-skills-project");
    const previous = join(root, "previous-skills");
    const next = join(root, "next-skills");
    const settings = join(workdir, ".ohbaby", "skills", "settings.json");
    await skill(previous, "previous-skill", "Previous configured directory");
    await skill(next, "next-skill", "Next configured directory");
    await json(settings, {
      directories: [{ path: previous, scope: "project" }],
    });
    const requests: InterfaceProviderRequest[] = [];
    const client = backend(workdir, requests);
    expect(
      JSON.stringify(await client.listCommands({ surface: "tui" })),
    ).toContain("previous-skill");
    await json(settings, { directories: [{ path: next, scope: "project" }] });
    expect(
      (
        await client.submitPromptAndWait("First runtime", {
          sessionId: "preloaded-skills",
        })
      ).prompt.status,
    ).toBe("succeeded");
    const tools = JSON.stringify(requests.at(-1)?.tools);
    expect(tools).toContain("next-skill: Next configured directory");
    expect(tools).not.toContain("previous-skill");
  });
  it.each(["search", "env"] as const)(
    "refreshes process search cache after a %s edit before a new instance's first runtime",
    async (domain) => {
      const a = join(root, "search-initial-a");
      const b = join(root, "search-initial-b");
      await mkdir(a);
      await mkdir(b);
      vi.stubEnv("INITIAL_SEARCH_KEY", undefined);
      await mkdir(globalRoot, { recursive: true });
      await writeFile(
        join(globalRoot, ".env"),
        "INITIAL_SEARCH_KEY=initial-env-key\n",
      );
      const searchFile = join(globalRoot, "tools", "search.json");
      await json(searchFile, {
        apiKeyEnv: "INITIAL_SEARCH_KEY",
        baseUrl: "https://first.search.example",
      });
      const first = backend(a, []);
      expect(
        (
          await first.submitPromptAndWait("First instance", {
            sessionId: "first",
          })
        ).prompt.status,
      ).toBe("succeeded");
      expect(await getSearchConfig()).toMatchObject({
        apiKey: "initial-env-key",
        baseUrl: "https://first.search.example",
      });
      if (domain === "search")
        await json(searchFile, {
          apiKeyEnv: "INITIAL_SEARCH_KEY",
          baseUrl: "https://changed.search.example",
        });
      else
        await writeFile(
          join(globalRoot, ".env"),
          "INITIAL_SEARCH_KEY=changed-env-key\n",
        );
      const second = backend(b, []);
      expect(
        (
          await second.submitPromptAndWait("New instance", {
            sessionId: "second",
          })
        ).prompt.status,
      ).toBe("succeeded");
      expect(await getSearchConfig()).toMatchObject({
        apiKey: domain === "env" ? "changed-env-key" : "initial-env-key",
        baseUrl:
          domain === "search"
            ? "https://changed.search.example"
            : "https://first.search.example",
      });
    },
  );
  it("preserves effective legacy search fields when the production key saver creates the current file", async () => {
    const workdir = join(root, "legacy-save-project");
    await mkdir(workdir);
    const legacyPath = join(
      root,
      "home",
      ".ohbaby-agent",
      "tools",
      "search.json",
    );
    const legacy = {
      baseUrl: "https://legacy-save.search.example",
      defaults: { maxResults: 8, topic: "finance" },
      apiKeyEnv: "TAVILY_API_KEY",
      provider: "tavily",
    };
    await json(legacyPath, legacy);
    const client = backend(workdir, []);
    expect(await getSearchConfig()).toMatchObject({
      baseUrl: legacy.baseUrl,
      defaults: legacy.defaults,
    });
    const result = await client.setSearchApiKey({
      apiKey: "legacy-save-local-key",
    });
    expect(result.searchJsonPath).toBe(
      join(globalRoot, "tools", "search.json"),
    );
    expect(JSON.parse(await readFile(result.searchJsonPath, "utf8"))).toEqual(
      legacy,
    );
    expect(JSON.parse(await readFile(legacyPath, "utf8"))).toEqual(legacy);
    expect(await getSearchConfig()).toMatchObject({
      apiKey: "legacy-save-local-key",
      baseUrl: legacy.baseUrl,
      defaults: legacy.defaults,
    });
  });
  it("loads configured Skill directories into the model tool and refreshes real files before each round or explicit use", async () => {
    const workdir = join(root, "project");
    const extra = join(root, "extra-skills");
    await json(join(workdir, ".ohbaby", "skills", "settings.json"), {
      directories: [{ path: extra, scope: "project" }],
    });
    const firstFile = await skill(extra, "first-skill", "Initial description");
    const requests: InterfaceProviderRequest[] = [];
    const client = backend(workdir, requests);
    const prompt = async (): Promise<string> => {
      const result = await client.submitPromptAndWait(
        "Describe available skills",
        { sessionId: "settings" },
      );
      expect(result.prompt.status).toBe("succeeded");
      return JSON.stringify(requests.at(-1)?.tools);
    };
    expect(await prompt()).toContain("first-skill: Initial description");
    await skill(extra, "first-skill", "Updated description", "Updated body");
    await skill(extra, "second-skill", "Newly added");
    const next = await prompt();
    expect(next).toContain("first-skill: Updated description");
    expect(next).toContain("second-skill: Newly added");
    const loaded = await client.executeCommand({
      commandId: "skill.first-skill",
      path: ["first-skill"],
      argv: [],
      rawArgs: "",
      raw: "/first-skill",
      surface: "tui",
      clientInvocationId: "use-updated",
      sessionId: "settings",
    });
    expect(loaded.promptReceipt).toBeDefined();
    if (!loaded.promptReceipt) throw new Error("Expected queued Skill prompt");
    await client.waitForPrompt(loaded.promptReceipt.promptId);
    expect(JSON.stringify(requests.at(-1))).toContain("Updated body");
    await rm(dirname(firstFile), { recursive: true });
    const removed = await prompt();
    expect(removed).not.toContain("first-skill");
    await skill(
      extra,
      "explicit-skill",
      "Explicit newly added",
      "Explicit fresh body",
    );
    const explicit = await client.executeCommand({
      commandId: "skill.explicit-skill",
      path: ["explicit-skill"],
      argv: [],
      rawArgs: "",
      raw: "/explicit-skill",
      surface: "tui",
      clientInvocationId: "use-new",
      sessionId: "settings",
    });
    expect(explicit.promptReceipt).toBeDefined();
    if (!explicit.promptReceipt)
      throw new Error("Expected queued Skill prompt");
    await client.waitForPrompt(explicit.promptReceipt.promptId);
    expect(JSON.stringify(requests.at(-1))).toContain("Explicit fresh body");
  });
  it("loads separate project Agents for two instances and applies hand-edited Agent and search files with an injected client", async () => {
    const captured: Awaited<
      ReturnType<typeof compositionModule.createUiRuntimeComposition>
    >[] = [];
    const create = compositionModule.createUiRuntimeComposition;
    vi.spyOn(
      compositionModule,
      "createUiRuntimeComposition",
    ).mockImplementation(async (options) => {
      const runtime = await create(options);
      captured.push(runtime);
      return runtime;
    });
    const a = join(root, "a");
    const b = join(root, "b");
    const agents = (description: string): Record<string, unknown> => ({
      agents: {
        "project-agent": {
          name: "project-agent",
          mode: "subagent",
          description,
          prompt: description,
        },
      },
    });
    await json(
      join(a, ".ohbaby", "agents", "settings.json"),
      agents("Agent A"),
    );
    await json(
      join(b, ".ohbaby", "agents", "settings.json"),
      agents("Agent B"),
    );
    await json(join(globalRoot, "tools", "search.json"), {
      baseUrl: "https://old.search.example",
      defaults: { maxResults: 3 },
    });
    const one = backend(a, []);
    const two = backend(b, []);
    expect(
      (await one.submitPromptAndWait("Hello", { sessionId: "a" })).prompt,
    ).toMatchObject({ status: "succeeded" });
    expect(
      (await two.submitPromptAndWait("Hello", { sessionId: "b" })).prompt,
    ).toMatchObject({ status: "succeeded" });
    expect(captured[0].agentManager.get("project-agent")?.description).toBe(
      "Agent A",
    );
    expect(captured[1].agentManager.get("project-agent")?.description).toBe(
      "Agent B",
    );
    expect((await getSearchConfig()).baseUrl).toBe(
      "https://old.search.example",
    );
    await json(
      join(a, ".ohbaby", "agents", "settings.json"),
      agents("Agent A changed"),
    );
    await json(join(globalRoot, "tools", "search.json"), {
      baseUrl: "https://new.search.example",
      defaults: { maxResults: 8 },
    });
    await one.submitPromptAndWait("Next", { sessionId: "a" });
    expect((await getSearchConfig()).baseUrl).toBe(
      "https://new.search.example",
    );
    expect((await getSearchConfig()).defaults.maxResults).toBe(8);
    expect(captured).toHaveLength(3);
    expect(captured[2].agentManager.get("project-agent")?.description).toBe(
      "Agent A changed",
    );
  });
  it("applies a legacy-only search file through the same effective path used by settings versions", async () => {
    const workdir = join(root, "legacy-search-project");
    await mkdir(workdir);
    const legacyPath = join(
      root,
      "home",
      ".ohbaby-agent",
      "tools",
      "search.json",
    );
    await json(legacyPath, {
      baseUrl: "https://legacy-first.search.example",
      defaults: { maxResults: 3 },
    });
    const client = backend(workdir, []);
    expect(
      (await client.submitPromptAndWait("First", { sessionId: "legacy" }))
        .prompt.status,
    ).toBe("succeeded");
    expect(await getSearchConfig()).toMatchObject({
      baseUrl: "https://legacy-first.search.example",
      defaults: { maxResults: 3 },
    });
    await json(legacyPath, {
      baseUrl: "https://legacy-updated.search.example",
      defaults: { maxResults: 8 },
    });
    expect(
      (await client.submitPromptAndWait("Next", { sessionId: "legacy" })).prompt
        .status,
    ).toBe("succeeded");
    expect(await getSearchConfig()).toMatchObject({
      baseUrl: "https://legacy-updated.search.example",
      defaults: { maxResults: 8 },
    });
    // A current file takes precedence; later changes to the legacy file are ignored by both sides.
    await json(join(globalRoot, "tools", "search.json"), {
      baseUrl: "https://current.search.example",
    });
    expect(
      (
        await client.submitPromptAndWait("Current path", {
          sessionId: "legacy",
        })
      ).prompt.status,
    ).toBe("succeeded");
    expect((await getSearchConfig()).baseUrl).toBe(
      "https://current.search.example",
    );
  });
  it("preserves search settings when saving a key and applies a later global env edit with an injected client", async () => {
    const workdir = join(root, "search-project");
    await mkdir(workdir);
    vi.stubEnv("STAGE1_SEARCH_KEY", undefined);
    await json(join(globalRoot, "tools", "search.json"), {
      baseUrl: "https://custom.search.example",
      defaults: { maxResults: 9 },
    });
    const client = backend(workdir, []);
    await client.setSearchApiKey({
      apiKey: "initial-local-key",
      apiKeyEnv: "STAGE1_SEARCH_KEY",
    });
    expect(await getSearchConfig()).toMatchObject({
      apiKey: "initial-local-key",
      baseUrl: "https://custom.search.example",
      defaults: { maxResults: 9 },
    });
    await client.submitPromptAndWait("First", { sessionId: "search" });
    await writeFile(
      join(globalRoot, ".env"),
      "STAGE1_SEARCH_KEY=updated-local-key\n",
    );
    await client.submitPromptAndWait("Next", { sessionId: "search" });
    expect((await getSearchConfig()).apiKey).toBe("updated-local-key");
  });
  it("switches the configured model through the normal loader against a local fake upstream", async () => {
    const { createServer } = await import("node:http");
    const receivedModels: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (request.url?.includes("chat/completions")) {
          receivedModels.push(
            (JSON.parse(Buffer.concat(chunks).toString()) as { model: string })
              .model,
          );
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            [
              `data: ${JSON.stringify({ id: "local-response", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: null }] })}`,
              `data: ${JSON.stringify({ id: "local-response", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
              "data: [DONE]",
              "",
            ].join("\n\n"),
          );
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: [] }));
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected local TCP address");
    const workdir = join(root, "normal-model-project");
    await mkdir(workdir);
    const save = (model: string): Promise<void> =>
      json(join(globalRoot, "model.json"), {
        provider: "local",
        defaultModel: model,
        apiConfig: {
          baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
          interfaceProvider: "openai-compatible",
          promptCache: "disabled",
        },
        llmParams: {
          maxTokens: 128,
          temperature: 0,
          contextWindowTokens: 128000,
        },
        models: [
          {
            model,
            contextWindowTokens: 128000,
            reasoningCapabilities: {
              mode: "none",
              wire: "none",
              supportsDisabled: true,
            },
          },
        ],
      });
    try {
      await save("model-a");
      const client = createInProcessUiBackendClient({ workdir });
      clients.push(client);
      expect(
        (
          await client.submitPromptAndWait("First model", {
            sessionId: "normal",
          })
        ).prompt.status,
      ).toBe("succeeded");
      expect(receivedModels.length).toBeGreaterThan(0);
      expect(receivedModels.every((model) => model === "model-a")).toBe(true);
      const previousRequests = receivedModels.length;
      await save("model-b");
      expect(
        (
          await client.submitPromptAndWait("Second model", {
            sessionId: "normal",
          })
        ).prompt.status,
      ).toBe("succeeded");
      expect(receivedModels.slice(previousRequests)).toEqual(["model-b"]);
      await client.dispose();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
  it("waits to apply settings while an injected client's current turn remains active", async () => {
    const workdir = join(root, "busy-project");
    await mkdir(workdir);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = createInProcessUiBackendClient({
      workdir,
      llmClient: recordingClient([], { entered, wait }),
    });
    clients.push(client);
    const events: UiEvent[] = [];
    client.subscribeEvents((event) => {
      events.push(event);
    });
    const other = await client.createSession();
    const old = client.submitPromptAndWait("Keep running", {
      sessionId: "busy",
    });
    try {
      await started;
      await json(join(workdir, ".ohbaby", "agents", "settings.json"), {
        agents: {},
      });
      await expect(
        client.compactSession({ sessionId: other.id, force: true }),
      ).rejects.toBeInstanceOf(RuntimeSwitchPendingError);
      expect(
        events.some(
          (event) =>
            event.type === "notice.emitted" &&
            event.notice.message.includes("Waiting to apply settings"),
        ),
      ).toBe(true);
      release();
      expect((await old).prompt.status).toBe("succeeded");
      expect(
        (await client.submitPromptAndWait("Next turn", { sessionId: "busy" }))
          .prompt.status,
      ).toBe("succeeded");
    } finally {
      release();
      await old;
    }
  });
  it("reconnects a real stdio MCP child on configuration changes, refreshes tools, and preserves it for model-only edits", async () => {
    const workdir = join(root, "stdio-project");
    await mkdir(workdir);
    const fixturePath = join(root, "local-mcp.mjs");
    const eventsPath = join(root, "stdio-events.jsonl");
    await writeFile(
      fixturePath,
      `
      import { appendFileSync } from "node:fs";
      import { createInterface } from "node:readline";
      const [eventsPath, tool] = process.argv.slice(2);
      const record = (type) => appendFileSync(eventsPath, JSON.stringify({ type, tool, pid: process.pid }) + "\\n");
      record("start");
      process.on("exit", () => record("stop"));
      process.on("SIGTERM", () => process.exit(0));
      process.stdin.on("end", () => process.exit(0));
      const lines = createInterface({ input: process.stdin });
      lines.on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        let result;
        if (request.method === "initialize") result = {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "local-stdio-fixture", version: "1.0.0" },
        };
        else if (request.method === "tools/list") result = { tools: [{ name: tool, description: "Local fixture tool", inputSchema: { type: "object", properties: {} } }] };
        else if (request.method === "tools/call") result = { content: [{ type: "text", text: tool }] };
        else if (request.method === "ping") result = {};
        else {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }) + "\\n");
          return;
        }
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      });
    `,
    );
    interface ChildEvent {
      type: string;
      tool: string;
      pid: number;
    }
    const events = async (): Promise<ChildEvent[]> =>
      (await readFile(eventsPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ChildEvent);
    const saveMcp = (tool: string): Promise<void> =>
      json(join(globalRoot, "mcp", "settings.json"), {
        mcpServers: {
          local: {
            type: "stdio",
            command: process.execPath,
            args: [fixturePath, eventsPath, tool],
          },
        },
      });
    const compositions: Awaited<
      ReturnType<typeof compositionModule.createUiRuntimeComposition>
    >[] = [];
    const createRuntime = compositionModule.createUiRuntimeComposition;
    vi.spyOn(
      compositionModule,
      "createUiRuntimeComposition",
    ).mockImplementation(async (options) => {
      const runtime = await createRuntime(options);
      compositions.push(runtime);
      return runtime;
    });
    await saveMcp("old_echo");
    const client = backend(workdir, []);
    expect(
      (
        await client.submitPromptAndWait("Initial tools", {
          sessionId: "stdio",
        })
      ).prompt.status,
    ).toBe("succeeded");
    const manager = McpManager.getInstance(workdir);
    expect(await manager.getStatus()).toEqual({
      local: { status: "connected", toolCount: 1 },
    });
    expect(
      (await compositions[0].listToolSummaries()).map((tool) => tool.name),
    ).toContain("mcp_s5_local_t9_old__echo");
    expect((await events()).map((event) => [event.type, event.tool])).toEqual([
      ["start", "old_echo"],
    ]);
    await saveMcp("new_echo");
    expect(
      (await events()).filter((event) => event.type === "start"),
    ).toHaveLength(1);
    expect(
      (
        await client.submitPromptAndWait("Updated tools", {
          sessionId: "stdio",
        })
      ).prompt.status,
    ).toBe("succeeded");
    const names = (await compositions[1].listToolSummaries()).map(
      (tool) => tool.name,
    );
    expect(names).toContain("mcp_s5_local_t9_new__echo");
    expect(names).not.toContain("mcp_s5_local_t9_old__echo");
    const restarted = await events();
    expect(
      restarted
        .filter((event) => event.type === "start")
        .map((event) => event.tool),
    ).toEqual(["old_echo", "new_echo"]);
    expect(
      new Set(
        restarted
          .filter((event) => event.type === "start")
          .map((event) => event.pid),
      ).size,
    ).toBe(2);
    expect(
      restarted
        .filter((event) => event.type === "stop")
        .map((event) => event.tool),
    ).toEqual(["old_echo"]);
    await json(join(globalRoot, "model.json"), {
      models: [],
    });
    expect(
      (
        await client.submitPromptAndWait("Model-only change", {
          sessionId: "stdio",
        })
      ).prompt.status,
    ).toBe("succeeded");
    expect(await events()).toEqual(restarted);
    await client.dispose();
    await manager.dispose();
    expect(
      (await events())
        .filter((event) => event.type === "stop")
        .map((event) => event.tool),
    ).toEqual(["old_echo", "new_echo"]);
  });
  it("reconnects MCP before the next admitted round and leaves MCP connected for a model-only edit", async () => {
    const workdir = join(root, "mcp-project");
    await mkdir(workdir);
    const connected: string[] = [];
    const disconnected: string[] = [];
    const manager = McpManager.getInstance(workdir, {
      createClient(name): McpClientLike {
        connected.push(name);
        return localMcp(name, () => {
          disconnected.push(name);
        });
      },
    });
    const config = (name: string): McpServersConfig => ({
      mcpServers: {
        [name]: {
          type: "stdio",
          command: "fake",
          args: [],
          enabled: true,
          trust: false,
          timeout: 5000,
        },
      },
    });
    await json(join(globalRoot, "mcp", "settings.json"), config("old"));
    let activeMcpSubscriptions = 0;
    const subscribeMcp = manager.onChange.bind(manager);
    vi.spyOn(manager, "onChange").mockImplementation((listener) => {
      activeMcpSubscriptions += 1;
      const unsubscribe = subscribeMcp(listener);
      return (): void => {
        activeMcpSubscriptions -= 1;
        unsubscribe();
      };
    });
    let activeSkillSubscriptions = 0;
    const sharedRegistries: unknown[] = [];
    const createRuntime = compositionModule.createUiRuntimeComposition;
    vi.spyOn(
      compositionModule,
      "createUiRuntimeComposition",
    ).mockImplementation(async (options) => {
      const registry = options.skillRegistry;
      if (!registry) throw new Error("Expected shared Skill registry");
      if (!sharedRegistries.includes(registry)) {
        const subscribeSkill = registry.onChange.bind(registry);
        vi.spyOn(registry, "onChange").mockImplementation((listener) => {
          activeSkillSubscriptions += 1;
          const unsubscribe = subscribeSkill(listener);
          return (): void => {
            activeSkillSubscriptions -= 1;
            unsubscribe();
          };
        });
      }
      sharedRegistries.push(registry);
      return createRuntime(options);
    });
    const requests: InterfaceProviderRequest[] = [];
    const client = backend(workdir, requests);
    await client.submitPromptAndWait("First", { sessionId: "mcp" });
    expect(await manager.getStatus()).toHaveProperty("old");
    await json(join(globalRoot, "mcp", "settings.json"), config("new"));
    expect(await manager.getStatus()).toHaveProperty("old");
    await client.submitPromptAndWait("Second", { sessionId: "mcp" });
    expect(await manager.getStatus()).toEqual({
      new: { status: "connected", toolCount: 1 },
    });
    expect(connected).toEqual(["old", "new"]);
    expect(disconnected).toEqual(["old"]);
    await json(join(globalRoot, "model.json"), {
      models: [],
    });
    await client.submitPromptAndWait("Third", { sessionId: "mcp" });
    expect(connected).toEqual(["old", "new"]);
    expect(disconnected).toEqual(["old"]);
    const replacementSkills = join(root, "replacement-skills");
    await skill(
      replacementSkills,
      "replacement-skill",
      "Changed configured directory",
    );
    await json(join(workdir, ".ohbaby", "skills", "settings.json"), {
      directories: [{ path: replacementSkills, scope: "project" }],
    });
    expect(
      (await client.submitPromptAndWait("Fourth", { sessionId: "mcp" })).prompt
        .status,
    ).toBe("succeeded");
    expect(JSON.stringify(requests.at(-1)?.tools)).toContain(
      "replacement-skill: Changed configured directory",
    );
    expect(new Set(sharedRegistries).size).toBe(1);
    expect(sharedRegistries).toHaveLength(3);
    expect(activeMcpSubscriptions).toBe(1);
    expect(activeSkillSubscriptions).toBe(1);
    await client.dispose();
    expect(activeMcpSubscriptions).toBe(0);
    expect(activeSkillSubscriptions).toBe(0);
  });
  it("refreshes a status-preloaded MCP manager before the first prompt after a config edit", async () => {
    const workdir = join(root, "status-preloaded");
    await mkdir(workdir);
    const config = (name: string): McpServersConfig => ({
      mcpServers: {
        [name]: {
          type: "stdio",
          command: "fake",
          args: [],
          enabled: true,
          trust: false,
          timeout: 5000,
        },
      },
    });
    const file = join(globalRoot, "mcp", "settings.json");
    await json(file, config("old"));
    let disconnected = 0;
    McpManager.getInstance(workdir, {
      createClient: (name) => localMcp(name, () => disconnected++),
    });
    const compositions: Awaited<
      ReturnType<typeof compositionModule.createUiRuntimeComposition>
    >[] = [];
    const compose = compositionModule.createUiRuntimeComposition;
    vi.spyOn(
      compositionModule,
      "createUiRuntimeComposition",
    ).mockImplementation(async (options) => {
      const runtime = await compose(options);
      compositions.push(runtime);
      return runtime;
    });
    const client = backend(workdir, []);
    expect(
      (await client.getSettingsMcpStatus()).map((server) => server.name),
    ).toEqual(["old"]);
    await json(file, config("new"));
    // Reading initialized status must not reconnect or apply the saved file.
    expect(
      (await client.getSettingsMcpStatus()).map((server) => server.name),
    ).toEqual(["old"]);
    expect(disconnected).toBe(0);
    expect(
      (
        await client.submitPromptAndWait("First prompt", {
          sessionId: "pre-read",
        })
      ).prompt.status,
    ).toBe("succeeded");
    const names = (await compositions[0].listToolSummaries()).map(
      (tool) => tool.name,
    );
    expect(names).toContain("mcp_s3_new_t4_echo");
    expect(names).not.toContain("mcp_s3_old_t4_echo");
    expect(disconnected).toBe(1);
    expect(
      (await client.getSettingsMcpStatus()).map((server) => server.name),
    ).toEqual(["new"]);
    await client.submitPromptAndWait("Same config", { sessionId: "pre-read" });
    expect(disconnected).toBe(1);
  });
  it("keeps settings Skills and the live model catalog synchronized through the shared registry", async () => {
    const workdir = join(root, "settings-skills");
    const directory = join(workdir, ".ohbaby", "skills");
    const original = await skill(
      directory,
      "original-skill",
      "Original description",
    );
    const requests: InterfaceProviderRequest[] = [];
    const compose = compositionModule.createUiRuntimeComposition;
    let runtime: Awaited<ReturnType<typeof compose>> | undefined;
    vi.spyOn(
      compositionModule,
      "createUiRuntimeComposition",
    ).mockImplementation(async (options) => {
      runtime = await compose(options);
      return runtime;
    });
    const client = backend(workdir, requests);
    await client.submitPromptAndWait("Initial", { sessionId: "skills-read" });
    const activeRuntime = runtime;
    if (!activeRuntime) throw new Error("Runtime was not created");
    expect(
      (await client.getSettingsSkills()).map((entry) => entry.name),
    ).toEqual(["original-skill"]);
    await skill(directory, "new-skill", "New description");
    await skill(directory, "original-skill", "Changed description");
    expect(
      (await client.getSettingsSkills()).map((entry) => entry.description),
    ).toEqual(["New description", "Changed description"]);
    expect(JSON.stringify(await activeRuntime.listToolSummaries())).toContain(
      "new-skill: New description",
    );
    expect(JSON.stringify(await activeRuntime.listToolSummaries())).toContain(
      "original-skill: Changed description",
    );
    await client.submitPromptAndWait("Updated", { sessionId: "skills-read" });
    expect(JSON.stringify(requests.at(-1)?.tools)).toContain(
      "original-skill: Changed description",
    );
    expect(JSON.stringify(requests.at(-1)?.tools)).toContain(
      "new-skill: New description",
    );
    await rm(dirname(original), { recursive: true });
    expect(
      (await client.getSettingsSkills()).map((entry) => entry.name),
    ).toEqual(["new-skill"]);
    expect(
      JSON.stringify(await activeRuntime.listToolSummaries()),
    ).not.toContain("original-skill");
    await client.submitPromptAndWait("Deleted", { sessionId: "skills-read" });
    expect(JSON.stringify(requests.at(-1)?.tools)).not.toContain(
      "original-skill",
    );
  });

  it("does not reparse unchanged Skill frontmatter on repeated settings reads", async () => {
    const workdir = join(root, "unchanged-settings-skills");
    await skill(
      join(workdir, ".ohbaby", "skills"),
      "cached-skill",
      "Cached description",
    );
    const scan = vi.spyOn(SkillLoader.prototype, "scan");
    const client = backend(workdir, []);
    expect(
      (await client.getSettingsSkills()).map((entry) => entry.name),
    ).toEqual(["cached-skill"]);
    const count = scan.mock.calls.length;
    expect(count).toBe(1);
    expect(
      (await client.getSettingsSkills()).map((entry) => entry.name),
    ).toEqual(["cached-skill"]);
    expect(scan.mock.calls.length).toBe(count);
  });

  describe("MCP connections stay outside the shared settings lock", () => {
    function hangingMcp(
      name: string,
      release: Promise<void>,
      connected: () => void,
    ): McpClientLike {
      return {
        ...localMcp(name, () => undefined),
        connect: (): Promise<void> => {
          connected();
          return release;
        },
      };
    }
    async function lockIsFree(): Promise<boolean> {
      const result = await Promise.race([
        coordinateModelConfig(undefined, () => Promise.resolve("free")),
        new Promise<string>((resolve) =>
          setTimeout(() => {
            resolve("blocked");
          }, 1000),
        ),
      ]);
      return result === "free";
    }
    async function hangingProject(name: string): Promise<{
      workdir: string;
      release: () => void;
      entered: Promise<void>;
    }> {
      const workdir = join(root, name);
      await mkdir(workdir);
      await json(join(workdir, ".ohbaby", "mcp", "settings.json"), {
        mcpServers: {
          slow: {
            type: "stdio",
            command: "fake",
            args: [],
            enabled: true,
            trust: false,
            timeout: 5000,
          },
        },
      });
      let connected!: () => void;
      const entered = new Promise<void>((resolve) => {
        connected = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      McpManager.getInstance(workdir, {
        createClient: (serverName): McpClientLike =>
          hangingMcp(serverName, gate, connected),
      });
      return { workdir, release, entered };
    }

    it("reads MCP status without holding the settings lock while a server connects", async () => {
      const { workdir, release, entered } = await hangingProject("slow-status");
      const client = backend(workdir, []);
      const status = client.getSettingsMcpStatus();
      try {
        await entered;
        expect(await lockIsFree()).toBe(true);
      } finally {
        release();
      }
      expect((await status).map((server) => server.name)).toEqual(["slow"]);
    });

    it("admits another project's round while one project's runtime is connecting MCP", async () => {
      const { workdir, release, entered } =
        await hangingProject("slow-runtime");
      const other = join(root, "fast-runtime");
      await mkdir(other);
      const slow = backend(workdir, []);
      const fast = backend(other, []);
      const pending = slow.submitPromptAndWait("Slow", { sessionId: "slow" });
      try {
        await entered;
        expect(await lockIsFree()).toBe(true);
        const result = await Promise.race([
          fast.submitPromptAndWait("Fast", { sessionId: "fast" }),
          new Promise<undefined>((resolve) =>
            setTimeout(() => {
              resolve(undefined);
            }, 5000),
          ),
        ]);
        expect(result?.prompt.status).toBe("succeeded");
      } finally {
        release();
      }
      expect((await pending).prompt.status).toBe("succeeded");
    });

    it("reconnects MCP without holding the settings lock while a server connects", async () => {
      const workdir = join(root, "slow-reconnect");
      await mkdir(workdir);
      const file = join(workdir, ".ohbaby", "mcp", "settings.json");
      await json(file, { mcpServers: {} });
      let connected!: () => void;
      const entered = new Promise<void>((resolve) => {
        connected = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      McpManager.getInstance(workdir, {
        createClient: (serverName): McpClientLike =>
          hangingMcp(serverName, gate, connected),
      });
      const client = backend(workdir, []);
      await client.submitPromptAndWait("Warm up", { sessionId: "warm" });
      await json(file, {
        mcpServers: {
          slow: {
            type: "stdio",
            command: "fake",
            args: [],
            enabled: true,
            trust: false,
            timeout: 5000,
          },
        },
      });
      const reconnect = client.reconnectSettingsMcp();
      try {
        await entered;
        expect(await lockIsFree()).toBe(true);
      } finally {
        release();
      }
      expect((await reconnect).map((server) => server.name)).toEqual(["slow"]);
    });
  });
  it("does not mark an old status initialization as the configuration of a newer first prompt", async () => {
    const workdir = join(root, "status-prompt-race");
    await mkdir(workdir);
    const file = join(workdir, ".ohbaby", "mcp", "settings.json");
    const config = (name: string): McpServersConfig => ({
      mcpServers: {
        [name]: {
          type: "stdio",
          command: "fake",
          args: [],
          enabled: true,
          trust: false,
          timeout: 5000,
        },
      },
    });
    await json(file, config("old"));
    let connected!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = McpManager.getInstance(workdir, {
      createClient: (name): McpClientLike => ({
        ...localMcp(name, () => undefined),
        connect: async (): Promise<void> => {
          if (name === "old") {
            connected();
            await gate;
          }
        },
      }),
    });
    const requests: InterfaceProviderRequest[] = [];
    const client = backend(workdir, requests);
    const status = client.getSettingsMcpStatus();
    await entered;
    await json(file, config("new"));
    let runtimeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      runtimeStarted = resolve;
    });
    const reload = manager.reload.bind(manager);
    vi.spyOn(manager, "reload").mockImplementation(async () => {
      runtimeStarted();
      await reload();
    });
    const compositions: Awaited<
      ReturnType<typeof compositionModule.createUiRuntimeComposition>
    >[] = [];
    const compose = compositionModule.createUiRuntimeComposition;
    vi.spyOn(
      compositionModule,
      "createUiRuntimeComposition",
    ).mockImplementation(async (options) => {
      runtimeStarted();
      const runtime = await compose(options);
      compositions.push(runtime);
      return runtime;
    });
    const prompt = client.submitPromptAndWait("First", { sessionId: "first" });
    try {
      await started;
    } finally {
      release();
    }
    await status;
    expect((await prompt).prompt.status).toBe("succeeded");
    expect(
      (await client.submitPromptAndWait("Next", { sessionId: "next" })).prompt
        .status,
    ).toBe("succeeded");
    for (const runtime of compositions) {
      const names = (await runtime.listToolSummaries()).map(
        (tool) => tool.name,
      );
      expect(names).toContain("mcp_s3_new_t4_echo");
      expect(names).not.toContain("mcp_s3_old_t4_echo");
    }
    expect(compositions).toHaveLength(1);
    expect(requests).toHaveLength(2);
  });
});
