import { SUBAGENT_DISABLED_TOOLS } from "../core/tool-scheduler/index.js";
import type { AgentToolConfigProvider } from "../core/tool-scheduler/index.js";
import {
  GENERIC_SUBAGENT_PROMPT,
  SystemPrompt,
} from "../core/system-prompt/index.js";
import { AgentRegistry } from "./registry.js";
import { formatSubagentRoles } from "./roles.js";
import type {
  AgentConfig,
  AgentMode,
  AgentPromptProvider,
  RuntimeAgent,
  ToolsConfig,
} from "./types.js";

export interface AgentManagerOptions {
  readonly registry?: AgentRegistry;
  readonly systemPromptProvider?: AgentPromptProvider;
}

const FALLBACK_SYSTEM_PROMPT_PROVIDER: AgentPromptProvider = {
  build({ agent, isSubagent }) {
    const promptAddon = agent.prompt?.trim()
      ? `<agent_prompt_addon>\n${agent.prompt.trim()}\n</agent_prompt_addon>`
      : undefined;
    if (!isSubagent) {
      return promptAddon ?? "";
    }

    const builtinPrompt = SystemPrompt.getAgentPrompt(agent.name);
    const description = agent.description?.trim()
      ? `Role: ${agent.description.trim()}`
      : undefined;
    return [
      SystemPrompt.getSubagentBase(),
      description,
      builtinPrompt ?? GENERIC_SUBAGENT_PROMPT,
      promptAddon,
    ]
      .filter((part): part is string => part !== undefined)
      .join("\n\n");
  },
};

export function toolsConfigToRecord(
  tools: ToolsConfig | undefined,
): Record<string, boolean> | undefined {
  if (!tools) {
    return undefined;
  }
  const result: Record<string, boolean> = {};
  if (tools.include) {
    result["*"] = false;
    for (const toolName of tools.include) {
      result[toolName] = true;
    }
  }
  for (const toolName of tools.exclude ?? []) {
    result[toolName] = false;
  }
  return result;
}

function isConfiguredSubagent(agent: AgentConfig): boolean {
  return agent.mode === "subagent";
}

function modeErrorMessage(agent: AgentConfig, isSubagent: boolean): string {
  if (isSubagent) {
    return [
      `Agent ${agent.name} is a primary agent and cannot be used as a subagent.`,
      `Allowed subagent roles are: ${formatSubagentRoles()}.`,
      "Omit role to use generic.",
    ].join(" ");
  }
  return `Agent ${agent.name} is a subagent and cannot be used as a primary agent.`;
}

function assertRuntimeMode(agent: AgentConfig, isSubagent: boolean): void {
  if (agent.mode === "all") {
    return;
  }
  if (isSubagent && agent.mode === "primary") {
    throw new Error(modeErrorMessage(agent, isSubagent));
  }
  if (!isSubagent && agent.mode === "subagent") {
    throw new Error(modeErrorMessage(agent, isSubagent));
  }
}

function withSubagentDisabledTools(
  tools: Record<string, boolean> | undefined,
  isSubagent: boolean,
): Record<string, boolean> | undefined {
  if (!isSubagent) {
    return tools;
  }
  const result = { ...(tools ?? {}) };
  for (const toolName of SUBAGENT_DISABLED_TOOLS) {
    result[toolName] = false;
  }
  return result;
}

export class AgentManager implements AgentToolConfigProvider {
  private readonly registry: AgentRegistry;
  private readonly systemPromptProvider: AgentPromptProvider;

  constructor(options: AgentManagerOptions = {}) {
    this.registry = options.registry ?? new AgentRegistry();
    this.systemPromptProvider =
      options.systemPromptProvider ?? FALLBACK_SYSTEM_PROMPT_PROVIDER;
  }

  async initialize(): Promise<void> {
    await this.registry.initialize();
  }

  get(name: string): AgentConfig | undefined {
    return this.registry.get(name);
  }

  list(filter: { readonly mode?: AgentMode } = {}): AgentConfig[] {
    return this.registry.list(filter);
  }

  getDefault(): string {
    const primaryAgents = this.registry.list({ mode: "primary" });
    const explicitDefault = primaryAgents.find(
      (agent) => agent.default === true,
    );
    if (explicitDefault) {
      return explicitDefault.name;
    }
    if (this.registry.get("build")) {
      return "build";
    }
    return primaryAgents[0]?.name ?? "build";
  }

  getAgentToolsConfig(
    agentName?: string,
    options: { readonly isSubagent?: boolean } = {},
  ): Record<string, boolean> | undefined {
    const name = agentName ?? this.getDefault();
    const agent = this.registry.get(name);
    if (!agent) {
      return undefined;
    }
    return withSubagentDisabledTools(
      toolsConfigToRecord(agent.tools),
      options.isSubagent ?? isConfiguredSubagent(agent),
    );
  }

  getAgentConfig(agentName?: string): {
    readonly tools?: Record<string, boolean>;
  } {
    return { tools: this.getAgentToolsConfig(agentName) };
  }

  async getRuntimeAgent(
    agentName?: string,
    options: { readonly isSubagent?: boolean } = {},
  ): Promise<RuntimeAgent> {
    const name = agentName ?? this.getDefault();
    const agent = this.registry.get(name);
    if (!agent) {
      throw new Error(`Agent not found: ${name}`);
    }
    const isSubagentAgent = options.isSubagent ?? isConfiguredSubagent(agent);
    assertRuntimeMode(agent, isSubagentAgent);
    return {
      config: agent,
      isSubagent: isSubagentAgent,
      systemPrompt: await this.systemPromptProvider.build({
        agent,
        isSubagent: isSubagentAgent,
      }),
      tools:
        this.getAgentToolsConfig(name, { isSubagent: isSubagentAgent }) ?? {},
    };
  }
}
