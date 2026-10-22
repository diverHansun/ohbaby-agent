import { SUBAGENT_DISABLED_TOOLS } from "../core/tool-scheduler/index.js";
import { loadAgentConfigWithOrigins } from "../config/agents/loaders.js";
import { BUILTIN_AGENTS } from "./builtin/index.js";
import { SUBAGENT_ROLES } from "./roles.js";
import {
  assertNoStaticModelConfig,
  type AgentConfig,
  type AgentMode,
  type AgentOrigin,
  type AgentsConfig,
} from "./types.js";

const AGENT_NAME_REGEX = /^[a-z0-9-]+$/;
const MAX_AGENT_NAME_LENGTH = 50;
const RESERVED_AGENT_NAMES = new Set<string>(SUBAGENT_ROLES);

export interface AgentRegistryOptions {
  readonly builtinAgents?: readonly AgentConfig[];
  readonly configLoader?: () => AgentsConfig | Promise<AgentsConfig>;
}

async function loadDefaultAgentConfig(): Promise<AgentsConfig> {
  return loadAgentConfigWithOrigins();
}

function cloneAgent(agent: AgentConfig): AgentConfig {
  return {
    ...agent,
    permission: agent.permission ? { ...agent.permission } : undefined,
    tools: agent.tools
      ? {
          exclude: agent.tools.exclude ? [...agent.tools.exclude] : undefined,
          include: agent.tools.include ? [...agent.tools.include] : undefined,
        }
      : undefined,
  };
}

function assertAgentName(name: string): void {
  if (!AGENT_NAME_REGEX.test(name)) {
    throw new Error(
      "Agent name must contain only lowercase letters, numbers, and hyphens",
    );
  }
  if (name.length > MAX_AGENT_NAME_LENGTH) {
    throw new Error(
      `Agent name must be at most ${String(MAX_AGENT_NAME_LENGTH)} characters`,
    );
  }
}

function assertMode(mode: unknown): asserts mode is AgentMode {
  if (mode !== "primary" && mode !== "subagent" && mode !== "all") {
    throw new Error(`Invalid agent mode: ${String(mode)}`);
  }
}

function validateAgent(agent: AgentConfig, source: string): void {
  assertNoStaticModelConfig(agent, source);
  assertAgentName(agent.name);
  assertMode(agent.mode);
  if (agent.mode === "subagent" && !agent.description?.trim()) {
    throw new Error(`Subagent must have a description: ${agent.name}`);
  }
  if (agent.mode === "subagent") {
    for (const toolName of agent.tools?.include ?? []) {
      if (SUBAGENT_DISABLED_TOOLS.has(toolName)) {
        throw new Error(`Subagent cannot enable disabled tool: ${toolName}`);
      }
    }
  }
}

function assertUserAgentCanOverride(name: string): void {
  if (RESERVED_AGENT_NAMES.has(name)) {
    throw new Error(`Agent ${name} is reserved and cannot be overridden`);
  }
}

function shouldExpose(agent: AgentConfig): boolean {
  return agent.disabled !== true;
}

export class AgentRegistry {
  private readonly options: AgentRegistryOptions;
  private readonly agents = new Map<string, AgentConfig>();
  private initialized = false;
  private readonly origins = new Map<string, AgentOrigin>();

  constructor(options: AgentRegistryOptions = {}) {
    this.options = options;
  }

  async initialize(): Promise<void> {
    const merged = new Map<string, AgentConfig>();
    const origins = new Map<string, AgentOrigin>();
    for (const agent of this.options.builtinAgents ?? BUILTIN_AGENTS) {
      validateAgent(agent, "builtinAgents");
      merged.set(agent.name, cloneAgent(agent));
      origins.set(agent.name, "builtin");
    }

    const configLoader = this.options.configLoader ?? loadDefaultAgentConfig;
    const userConfig = await configLoader();
    for (const [configName, agent] of Object.entries(userConfig.agents)) {
      validateAgent(agent, "configLoader");
      assertUserAgentCanOverride(agent.name);
      merged.set(agent.name, cloneAgent(agent));
      origins.set(agent.name, userConfig.origins?.[configName] ?? "global");
    }

    this.agents.clear();
    this.origins.clear();
    for (const [name, agent] of merged) {
      if (shouldExpose(agent)) {
        this.agents.set(name, agent);
        this.origins.set(name, origins.get(name) ?? "builtin");
      }
    }
    this.initialized = true;
  }

  get(name: string): AgentConfig | undefined {
    return this.agents.get(name);
  }

  list(filter: { readonly mode?: AgentMode } = {}): AgentConfig[] {
    const agents = Array.from(this.agents.values());
    if (!filter.mode) {
      return agents;
    }
    return agents.filter(
      (agent) => agent.mode === filter.mode || agent.mode === "all",
    );
  }

  listWithOrigins(): (AgentConfig & { readonly origin: AgentOrigin })[] {
    return this.list().map((agent) => ({
      ...agent,
      origin: this.origins.get(agent.name) ?? "builtin",
    }));
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
