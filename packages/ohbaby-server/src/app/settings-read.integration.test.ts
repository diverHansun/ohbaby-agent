import { createDaemonHttpServer } from "../runtime/daemon/server.js";
import type {
  UiSettingsMcpStatusResponse,
  UiSettingsSkillsResponse,
  UiSettingsAgentsResponse,
} from "ohbaby-sdk";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInProcessUiBackendClient,
  createPersistentUiBackendClient,
} from "ohbaby-agent";
import { McpManager } from "../../../ohbaby-agent/src/mcp/core/manager.js";
import { createDaemonServerApp } from "./create-app.js";

async function json(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

describe("instance settings HTTP reads without a configured model", () => {
  let root: string;
  let globalRoot: string;
  let project: string;
  const backends: ReturnType<typeof createInProcessUiBackendClient>[] = [];
  const apps: ReturnType<typeof createDaemonServerApp>[] = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ohbaby-settings-read-"));
    globalRoot = join(root, "global");
    project = join(root, "project");
    await mkdir(project);
    vi.stubEnv("OHBABY_HOME", globalRoot);
    vi.stubEnv("HOME", join(root, "home"));
    vi.stubEnv("USERPROFILE", join(root, "home"));
    vi.stubEnv("CODEX_HOME", join(root, "codex"));
    await json(join(globalRoot, "model.json"), { models: [] });
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.dispose()));
    await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
    await McpManager.disposeAll();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  function app(
    directory = project,
  ): ReturnType<typeof createDaemonServerApp>["app"] {
    const backend = createInProcessUiBackendClient({ workdir: directory });
    backends.push(backend);
    const handle = createDaemonServerApp({ backend, authToken: "test-token" });
    apps.push(handle);
    return handle.app;
  }
  function headers(directory = project): Record<string, string> {
    return {
      authorization: "Bearer test-token",
      "x-ohbaby-directory": directory,
    };
  }
  async function skill(
    directory: string,
    name: string,
    description: string,
  ): Promise<string> {
    const file = join(directory, name, "SKILL.md");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      `---\nname: ${name}\ndescription: ${description}\nuser-invocable: false\ndisable-model-invocation: true\n---\nInstructions\n`,
    );
    return file;
  }
  it.each(["mcp/status", "skills", "agents"])(
    "requires token and directory for %s, without client registration",
    async (endpoint) => {
      const server = app();
      expect((await server.request(`/v1/settings/${endpoint}`)).status).toBe(
        401,
      );
      expect(
        (
          await server.request(`/v1/settings/${endpoint}`, {
            headers: { authorization: "Bearer test-token" },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await server.request(`/v1/settings/${endpoint}`, {
            headers: headers(),
          })
        ).status,
      ).toBe(200);
      await rm(join(globalRoot, "model.json"));
      expect(
        (
          await server.request(`/v1/settings/${endpoint}`, {
            headers: headers(),
          })
        ).status,
      ).toBe(200);
    },
  );
  it("T5 exposes effective MCP origins and filtered tools from the actual directory manager", async () => {
    const fixture = join(root, "mcp.cjs");
    await writeFile(
      fixture,
      `const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
 const request = JSON.parse(line); if (request.id === undefined) return;
 const result = request.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : request.method === 'tools/list' ? { tools: [{name:'keep',description:'Visible tool',inputSchema:{type:'object'}},{name:'remove',inputSchema:{type:'object'}}] } : {};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});`,
    );
    const config = {
      command: process.execPath,
      args: [fixture],
      enabled: true,
      trust: false,
      timeout: 5000,
      type: "stdio" as const,
    };
    await json(join(globalRoot, "mcp", "settings.json"), {
      mcpServers: {
        global: config,
        shared: config,
        disabled: { ...config, enabled: false },
        failed: { ...config, command: join(root, "does-not-exist") },
      },
    });
    await json(join(project, ".ohbaby", "mcp", "settings.json"), {
      mcpServers: { shared: { ...config, includeTools: ["keep"] } },
    });
    const manager = McpManager.getInstance(project);
    await manager.registerPluginServers("plugin", {
      plugin: { ...config, excludeTools: ["remove"] },
      shared: config,
    });
    const response = await app().request("/v1/settings/mcp/status", {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as UiSettingsMcpStatusResponse;
    expect(body.ok).toBe(true);
    expect(
      body.servers.map((server: { name: string; origin: string }) => [
        server.name,
        server.origin,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["global", "global"],
        ["shared", "project"],
        ["plugin", "plugin"],
        ["disabled", "global"],
        ["failed", "global"],
      ]),
    );
    const shared = body.servers.find(
      (server: { name: string }) => server.name === "shared",
    );
    expect(shared).toMatchObject({
      enabled: true,
      status: "connected",
      toolCount: 1,
      tools: [
        {
          description: "Visible tool",
          mcpToolName: "keep",
          name: expect.any(String) as unknown,
        },
      ],
    });
    expect(
      body.servers.find(
        (server: { name: string }) => server.name === "disabled",
      ),
    ).toMatchObject({
      enabled: false,
      status: "disabled",
      toolCount: 0,
      tools: [],
    });
    expect(
      body.servers.find((server: { name: string }) => server.name === "failed"),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("ENOENT") as unknown,
      toolCount: 0,
    });
    for (const server of body.servers)
      expect(server.toolCount).toBe(server.tools.length);
    expect(
      (await manager.getAllTools()).filter(
        (tool) => tool.mcpServer === "shared",
      ),
    ).toHaveLength(1);
    await json(join(project, ".ohbaby", "mcp", "settings.json"), {
      mcpServers: { changed: { ...config, enabled: false } },
    });
    const again = await app().request("/v1/settings/mcp/status", {
      headers: headers(),
    });
    expect(
      ((await again.json()) as UiSettingsMcpStatusResponse).servers.map(
        (server: { name: string }) => server.name,
      ),
    ).toContain("shared");
  });
  it("T6 returns complete effective Skills for each directory and reflects additions, edits and removals", async () => {
    const skillPath = await skill(
      join(project, ".ohbaby", "skills"),
      "local-skill",
      "Local skill",
    );
    const other = join(root, "other");
    await mkdir(other);
    await skill(join(other, ".ohbaby", "skills"), "other-skill", "Other skill");
    const a = app();
    const b = app(other);
    const read = async (
      server = a,
      directory = project,
    ): Promise<UiSettingsSkillsResponse["skills"]> =>
      (
        (await (
          await server.request("/v1/settings/skills", {
            headers: headers(directory),
          })
        ).json()) as UiSettingsSkillsResponse
      ).skills;
    expect(await read()).toEqual([
      {
        name: "local-skill",
        description: "Local skill",
        source: "project-native",
        scope: "project",
        location: skillPath,
        userInvocable: false,
        modelInvocable: false,
      },
    ]);
    expect(
      (await read(b, other)).map((item: { name: string }) => item.name),
    ).toEqual(["other-skill"]);
    await skill(
      join(project, ".ohbaby", "skills"),
      "local-skill",
      "Updated longer description",
    );
    await skill(join(project, ".ohbaby", "skills"), "added-skill", "Added");
    expect(
      (await read()).map((item: { description: string }) => item.description),
    ).toEqual(["Added", "Updated longer description"]);
    await rm(dirname(skillPath), { recursive: true });
    expect((await read()).map((item: { name: string }) => item.name)).toEqual([
      "added-skill",
    ]);
    const configured = join(root, "configured");
    await skill(configured, "configured-skill", "Configured");
    await json(join(project, ".ohbaby", "skills", "settings.json"), {
      directories: [{ path: configured, scope: "project" }],
    });
    expect((await read()).map((item: { name: string }) => item.name)).toContain(
      "configured-skill",
    );
  });
  it("T7 reports builtin/global/project Agent origins and removes disabled overrides", async () => {
    await json(join(globalRoot, "agents", "settings.json"), {
      agents: {
        global: { name: "global", mode: "subagent", description: "Global" },
        shared: {
          name: "shared",
          mode: "primary",
          description: "Global shared",
        },
        removed: { name: "removed", mode: "primary" },
      },
    });
    await json(join(project, ".ohbaby", "agents", "settings.json"), {
      agents: {
        local: {
          name: "local",
          mode: "primary",
          description: "Project",
          hidden: true,
        },
        shared: {
          name: "shared",
          mode: "primary",
          description: "Project shared",
        },
        removed: { name: "removed", mode: "primary", disabled: true },
      },
    });
    const response = await app().request("/v1/settings/agents", {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const { agents } = (await response.json()) as UiSettingsAgentsResponse;
    expect(agents).toEqual(
      expect.arrayContaining([
        {
          name: "global",
          description: "Global",
          mode: "subagent",
          hidden: false,
          origin: "global",
        },
        {
          name: "shared",
          description: "Project shared",
          mode: "primary",
          hidden: false,
          origin: "project",
        },
        {
          name: "local",
          description: "Project",
          mode: "primary",
          hidden: true,
          origin: "project",
        },
      ]),
    );
    expect(
      agents.find((agent: { name: string }) => agent.name === "build"),
    ).toMatchObject({ origin: "builtin", mode: "primary" });
    expect(agents.map((agent: { name: string }) => agent.name)).not.toContain(
      "removed",
    );
  });
  it("keeps the persistent backend settings reads usable before any model is configured", async () => {
    const backend = createPersistentUiBackendClient({
      workdir: project,
      storageRoot: join(root, "storage"),
    });
    try {
      const handle = createDaemonServerApp({
        backend,
        authToken: "test-token",
      });
      apps.push(handle);
      for (const endpoint of ["skills", "agents", "mcp/status"]) {
        const response = await handle.app.request(`/v1/settings/${endpoint}`, {
          headers: headers(),
        });
        expect(response.status).toBe(200);
      }
    } finally {
      await backend.dispose();
    }
  });
  it("does not expose configured MCP credentials in HTTP failure details", async () => {
    await json(join(globalRoot, "mcp", "settings.json"), {
      mcpServers: {
        failed: {
          type: "http",
          url: "http://user:pass@localhost/mcp?token=query-secret",
          headers: { "X-Secret": "header-secret" },
        },
      },
    });
    McpManager.getInstance(project, {
      createClient: (name, config) => ({
        name,
        config,
        connect: (): Promise<void> =>
          Promise.reject(
            new Error(
              "Connection refused http://user:pass@localhost/mcp?token=query-secret header-secret",
            ),
          ),
        disconnect: (): Promise<void> => Promise.resolve(),
        listTools: (): Promise<never[]> => Promise.resolve([]),
        callTool: (): Promise<Record<string, never>> => Promise.resolve({}),
        getStatus: (): { status: "disconnected" } => ({
          status: "disconnected",
        }),
      }),
    });
    const response = await app().request("/v1/settings/mcp/status", {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as UiSettingsMcpStatusResponse;
    expect(body.servers[0].error).toContain("Connection refused");
    for (const secret of ["user", "pass", "query-secret", "header-secret"])
      expect(JSON.stringify(body)).not.toContain(secret);
    expect(body.servers[0].error).toContain("[REDACTED]");
  });

  it.each(["mcp/status", "skills", "agents"])(
    "returns a safe HTTP error if the %s reader rejects",
    async (endpoint) => {
      const server = app();
      const fail = (): Promise<never> =>
        Promise.reject(
          new Error(
            "Bad configuration token=private-token Authorization: Bearer private-bearer",
          ),
        );
      const backend = backends.at(-1);
      if (!backend) throw new Error("Backend was not created");
      backend.getSettingsMcpStatus = fail;
      backend.getSettingsSkills = fail;
      backend.getSettingsAgents = fail;
      const response = await server.request(`/v1/settings/${endpoint}`, {
        headers: headers(),
      });
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain("private-token");
      expect(text).not.toContain("private-bearer");
      expect(JSON.parse(text)).toMatchObject({
        ok: false,
        error: { message: "Unable to read instance settings" },
      });
    },
  );

  it("routes each settings read to the directory selected by the HTTP header", async () => {
    const other = join(root, "other-routed-project");
    await mkdir(other);
    await skill(join(project, ".ohbaby", "skills"), "project-a", "A");
    await skill(join(other, ".ohbaby", "skills"), "project-b", "B");
    const a = await realpath(project);
    const backend = createInProcessUiBackendClient({ workdir: a });
    backends.push(backend);
    const server = createDaemonHttpServer({
      backend,
      authToken: "test-token",
      host: "127.0.0.1",
      port: 0,
      scopeRoot: a,
      createWorkspaceBackend: (scopeKey) => {
        const next = createInProcessUiBackendClient({ workdir: scopeKey });
        backends.push(next);
        return next;
      },
    });
    try {
      await server.start();
      for (const [directory, name] of [
        [project, "project-a"],
        [other, "project-b"],
      ]) {
        const response = await fetch(`${server.url}/v1/settings/skills`, {
          headers: headers(directory),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as UiSettingsSkillsResponse;
        expect(body.skills.map((entry) => entry.name)).toEqual([name]);
      }
      expect(
        (
          await fetch(`${server.url}/v1/settings/skills`, {
            headers: { authorization: "Bearer test-token" },
          })
        ).status,
      ).toBe(400);
    } finally {
      await server.stop();
    }
  });
  it("T7 preserves Agent provenance when record aliases differ from agent names", async () => {
    await json(join(globalRoot, "agents", "settings.json"), {
      agents: {
        sharedAlias: {
          name: "custom-agent",
          mode: "primary",
          description: "Global",
        },
        globalAlias: {
          name: "global-only",
          mode: "primary",
          description: "Global only",
        },
        removedAlias: { name: "removed-agent", mode: "primary" },
      },
    });
    await json(join(project, ".ohbaby", "agents", "settings.json"), {
      agents: {
        sharedAlias: {
          name: "custom-agent",
          mode: "primary",
          description: "Project override",
        },
        projectAlias: {
          name: "project-only",
          mode: "primary",
          description: "Project only",
        },
        removedAlias: {
          name: "removed-agent",
          mode: "primary",
          disabled: true,
        },
      },
    });
    const response = await app().request("/v1/settings/agents", {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const { agents } = (await response.json()) as UiSettingsAgentsResponse;
    expect(agents.find((agent) => agent.name === "custom-agent")).toMatchObject(
      { origin: "project", description: "Project override" },
    );
    expect(agents.find((agent) => agent.name === "project-only")).toMatchObject(
      { origin: "project", description: "Project only" },
    );
    expect(agents.find((agent) => agent.name === "global-only")).toMatchObject({
      origin: "global",
    });
    expect(agents.map((agent) => agent.name)).not.toContain("removed-agent");
    expect(agents.map((agent) => agent.name)).not.toContain("sharedAlias");
  });
});
