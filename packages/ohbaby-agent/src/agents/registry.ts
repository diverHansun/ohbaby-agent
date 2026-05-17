import { SUBAGENT_DISABLED_TOOLS } from "../core/tool-scheduler/index.js";
import { loadAgentConfig } from "../config/agents/index.js";
import { BUILTIN_AGENTS } from "./builtin/index.js";
import type { AgentConfig, AgentMode, AgentsConfig } from "./types.js";

const AGENT_NAME_REGEX = /^[a-z0-9-]+$/;
const MAX_AGENT_NAME_LENGTH = 50;

export interface AgentRegistryOptions {
  readonly builtinAgents?: readonly AgentConfig[];
  readonly configLoader?: () => AgentsConfig | Promise<AgentsConfig>;
}

async function loadDefaultAgentConfig(): Promise<AgentsConfig> {
  return loadAgentConfig();
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

function validateAgent(agent: AgentConfig): void {
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

function shouldExpose(agent: AgentConfig): boolean {
  return agent.disabled !== true;
}

export class AgentRegistry {
  private readonly options: AgentRegistryOptions;
  private readonly agents = new Map<string, AgentConfig>();
  private initialized = false;

  constructor(options: AgentRegistryOptions = {}) {
    this.options = options;
  }

  async initialize(): Promise<void> {
    const merged = new Map<string, AgentConfig>();
    for (const agent of this.options.builtinAgents ?? BUILTIN_AGENTS) {
      validateAgent(agent);
      merged.set(agent.name, cloneAgent(agent));
    }

    const configLoader = this.options.configLoader ?? loadDefaultAgentConfig;
    const userConfig = await configLoader();
    for (const agent of Object.values(userConfig.agents)) {
      validateAgent(agent);
      merged.set(agent.name, cloneAgent(agent));
    }

    this.agents.clear();
    for (const [name, agent] of merged) {
      if (shouldExpose(agent)) {
        this.agents.set(name, agent);
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

  isInitialized(): boolean {
    return this.initialized;
  }
}
