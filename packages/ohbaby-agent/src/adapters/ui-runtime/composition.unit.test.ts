import { describe, expect, it } from "vitest";
import { AgentManager } from "../../agents/index.js";
import { createBus } from "../../bus/index.js";
import type { LLMClientInstance } from "../../core/llm-client/index.js";
import type { MessageManager } from "../../core/message/index.js";
import { createPolicyManager } from "../../policy/index.js";
import type { Tool } from "../../core/tool-scheduler/index.js";
import type {
  SkillContent,
  SkillInfo,
  SkillRegistryChangeListener,
  SkillRegistryPort,
  SkillResourceContent,
  SkillSearchDirectory,
} from "../../skill/index.js";
import { createUiRuntimeComposition } from "./composition.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

function fakeLlmClient(): LLMClientInstance<FakeSdkClient> {
  return {
    config: {
      baseUrl: "https://example.invalid/v1",
      maxTokens: 128,
      model: "fake-model",
      provider: "fake",
      temperature: 0,
    },
    provider: {
      client: { kind: "fake" },
      id: "fake",
      isAbortError(): boolean {
        return false;
      },
      kind: "openai-compatible",
      streamChatCompletion(): Promise<AsyncIterable<never>> {
        return Promise.reject(new Error("No fake response configured"));
      },
    },
  };
}

function skill(name: string, description: string): SkillInfo {
  return {
    allowedTools: [],
    baseDir: `/skills/${name}`,
    description,
    disableModelInvocation: false,
    frontmatter: { description, name },
    location: `/skills/${name}/SKILL.md`,
    metadata: {},
    name,
    scope: "project",
    source: "project-native",
    userInvocable: true,
  };
}

function content(info: SkillInfo): SkillContent {
  return {
    baseDir: info.baseDir,
    content: `# ${info.name}`,
    files: [],
    info,
  };
}

function resource(info: SkillInfo): SkillResourceContent {
  return {
    baseDir: info.baseDir,
    content: "notes",
    info,
    path: "notes.md",
  };
}

function createMutableSkillRegistry(
  initialSkills: readonly SkillInfo[],
): SkillRegistryPort {
  let skills = [...initialSkills];
  const listeners = new Set<SkillRegistryChangeListener>();

  function emitChange(): void {
    for (const listener of listeners) {
      void listener();
    }
  }

  return {
    all: () => Promise.resolve(skills),
    deregisterPlugin(pluginId: string): void {
      skills = skills.filter((candidate) => candidate.pluginId !== pluginId);
      emitChange();
    },
    get: (name: string) =>
      Promise.resolve(skills.find((candidate) => candidate.name === name)),
    invalidate(): void {
      return undefined;
    },
    listModelInvocable: () =>
      Promise.resolve(
        skills.filter((candidate) => !candidate.disableModelInvocation),
      ),
    listNames: () => Promise.resolve(skills.map((candidate) => candidate.name)),
    listUserInvocable: () =>
      Promise.resolve(skills.filter((candidate) => candidate.userInvocable)),
    load: (name: string): Promise<SkillContent> => {
      const info = skills.find((candidate) => candidate.name === name);
      if (!info) {
        throw new Error(`missing skill ${name}`);
      }
      return Promise.resolve(content(info));
    },
    onChange(listener: SkillRegistryChangeListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    readResource: (
      name: string,
      _resourcePath: string,
    ): Promise<SkillResourceContent> => {
      const info = skills.find((candidate) => candidate.name === name);
      if (!info) {
        throw new Error(`missing skill ${name}`);
      }
      return Promise.resolve(resource(info));
    },
    registerPluginSkills(
      pluginId: string,
      _directories: readonly (string | SkillSearchDirectory)[],
    ): void {
      skills = [
        ...skills,
        {
          ...skill("plugin-skill", "Plugin skill"),
          pluginId,
          source: "plugin",
        },
      ];
      emitChange();
    },
    reload(): Promise<void> {
      emitChange();
      return Promise.resolve();
    },
  };
}

function findToolDescription(
  tools: readonly { readonly description: string; readonly name: string }[],
  name: string,
): string {
  return tools.find((tool) => tool.name === name)?.description ?? "";
}

interface FakeMcpManager {
  getAllTools(): Promise<readonly Tool[]>;
  onChange?(listener: () => void | Promise<void>): () => void;
}

function mcpTool(name: string): Tool {
  return {
    category: "readonly",
    description: "Echo from MCP",
    execute: () => ({ output: "echo" }),
    name,
    parametersJsonSchema: { properties: {}, type: "object" },
    source: "mcp",
  };
}

describe("createUiRuntimeComposition skill tools", () => {
  it("registers the resource tool and refreshes skill descriptions after registry changes", async () => {
    const bus = createBus();
    const registry = createMutableSkillRegistry([
      skill("base-skill", "Base skill"),
    ]);
    const composition = await createUiRuntimeComposition({
      agentManager: new AgentManager(),
      bus,
      llmClient: fakeLlmClient(),
      messageManager: {} as MessageManager,
      policy: createPolicyManager({ bus }),
      skillRegistry: registry,
    });

    const initialTools = await composition.toolScheduler.getAvailableTools();
    expect(initialTools.map((tool) => tool.name)).toContain("skill_resource");
    expect(findToolDescription(initialTools, "skill")).toContain("base-skill");
    expect(findToolDescription(initialTools, "skill")).not.toContain(
      "plugin-skill",
    );

    registry.registerPluginSkills("example-plugin", [
      "/plugins/example/skills",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const refreshedTools = await composition.toolScheduler.getAvailableTools();
    expect(findToolDescription(refreshedTools, "skill")).toContain(
      "plugin-skill",
    );
  });

  it("registers MCP tools supplied by the MCP manager", async () => {
    const bus = createBus();
    const mcpManager: FakeMcpManager = {
      getAllTools: () => Promise.resolve([mcpTool("mcp_s6_server_t4_echo")]),
    };
    const options = {
      agentManager: new AgentManager(),
      bus,
      llmClient: fakeLlmClient(),
      mcpManager,
      messageManager: {} as MessageManager,
      policy: createPolicyManager({ bus }),
      skillRegistry: createMutableSkillRegistry([]),
    } satisfies Parameters<typeof createUiRuntimeComposition>[0] & {
      readonly mcpManager: FakeMcpManager;
    };

    const composition = await createUiRuntimeComposition(options);

    const tools = await composition.toolScheduler.getAvailableTools();
    expect(tools.map((tool) => tool.name)).toContain("mcp_s6_server_t4_echo");
  });

  it("replaces stale MCP tools after the MCP manager changes", async () => {
    const bus = createBus();
    let tools = [mcpTool("mcp_s6_server_t3_old")];
    const listeners = new Set<() => void | Promise<void>>();
    const mcpManager: FakeMcpManager = {
      getAllTools: () => Promise.resolve(tools),
      onChange(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const options = {
      agentManager: new AgentManager(),
      bus,
      llmClient: fakeLlmClient(),
      mcpManager,
      messageManager: {} as MessageManager,
      policy: createPolicyManager({ bus }),
      skillRegistry: createMutableSkillRegistry([]),
    } satisfies Parameters<typeof createUiRuntimeComposition>[0] & {
      readonly mcpManager: FakeMcpManager;
    };
    const composition = await createUiRuntimeComposition(options);

    tools = [mcpTool("mcp_s6_server_t3_new")];
    for (const listener of listeners) {
      void listener();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    const refreshedTools = await composition.toolScheduler.getAvailableTools();
    const names = refreshedTools.map((tool) => tool.name);
    expect(names).toContain("mcp_s6_server_t3_new");
    expect(names).not.toContain("mcp_s6_server_t3_old");
  });
});
