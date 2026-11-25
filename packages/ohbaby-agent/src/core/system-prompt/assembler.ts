import type {
  SystemPromptProvider,
  SystemPromptProviderInput,
} from "../context/index.js";
import {
  detectEnvironment,
  generateBasePrompt,
  generateEnvironmentPrompt,
} from "./layers/index.js";
import { getBuiltinAgentPrompt } from "./prompts/agents/index.js";
import { getPrimaryTaskPrompt } from "./prompts/primary/tasks.js";
import { SUBAGENT_ROLES_GUIDANCE_PROMPT } from "./prompts/primary/subagent-roles.js";
import { SUBAGENT_BASE_PROMPT } from "./prompts/subagents/base.js";
import { getSubagentTaskPrompt } from "./prompts/subagents/tasks.js";
import type {
  AssembleOptions,
  EnvironmentInfo,
  PromptTaskKind,
  SubagentRolePromptInfo,
  SubagentTaskKind,
} from "./types.js";

export interface SystemPromptProviderOptions {
  readonly agentNameResolver?: (
    input: SystemPromptProviderInput,
  ) => Promise<string | undefined> | string | undefined;
  readonly agentPromptResolver?: (
    agentName: string,
    input: SystemPromptProviderInput,
  ) => Promise<string | undefined> | string | undefined;
  readonly environmentDetector?: (
    directory: string,
    input: SystemPromptProviderInput,
  ) => Promise<EnvironmentInfo> | EnvironmentInfo;
  readonly taskKindResolver?: (
    input: SystemPromptProviderInput,
    agentName: string,
  ) => Promise<PromptTaskKind | undefined> | PromptTaskKind | undefined;
  readonly availableSubagentRolesProvider?: (
    input: SystemPromptProviderInput,
  ) =>
    | Promise<readonly SubagentRolePromptInfo[]>
    | readonly SubagentRolePromptInfo[];
}

function assertAssembleOptions(options: AssembleOptions): void {
  if (options.agentName.trim() === "") {
    throw new Error("agentName is required");
  }
  if (typeof options.isSubagent !== "boolean") {
    throw new Error("isSubagent is required");
  }
}

function compactPrompts(prompts: readonly string[]): string[] {
  return prompts.filter((prompt) => prompt.trim() !== "");
}

function isSubagentTaskKind(value: unknown): value is SubagentTaskKind {
  return value === "explore" || value === "research" || value === "generic";
}

function resolveSubagentTaskKind(
  agentName: string,
  taskKind: PromptTaskKind | undefined,
): SubagentTaskKind {
  if (isSubagentTaskKind(taskKind)) {
    return taskKind;
  }
  const normalizedAgentName = agentName.trim().toLowerCase();
  return isSubagentTaskKind(normalizedAgentName)
    ? normalizedAgentName
    : "generic";
}

function generateAgentAddonPrompt(prompt: string | undefined): string {
  const trimmed = prompt?.trim();
  return trimmed
    ? `<agent_prompt_addon>\n${trimmed}\n</agent_prompt_addon>`
    : "";
}

function generateSubagentRolesPrompt(
  roles: readonly SubagentRolePromptInfo[] | undefined,
): string {
  if (!roles || roles.length === 0) {
    return "";
  }
  const roleLines = roles.map((role) => {
    const suffix = role.default === true ? " (default)" : "";
    return `- ${role.role}${suffix}: ${role.description}`;
  });
  // Use a function replacer so "$" sequences in role descriptions (e.g. "$&",
  // "$1") are inserted literally rather than interpreted as replacement patterns.
  return SUBAGENT_ROLES_GUIDANCE_PROMPT.replace("{{ROLES}}", () =>
    roleLines.join("\n"),
  );
}

export const SystemPrompt = {
  assemble(options: AssembleOptions): string[] {
    assertAssembleOptions(options);
    const isSubagent = options.isSubagent;
    const agentPromptAddon = options.agentPromptAddon ?? options.agentPrompt;

    if (isSubagent) {
      return compactPrompts([
        SUBAGENT_BASE_PROMPT,
        getSubagentTaskPrompt(
          resolveSubagentTaskKind(options.agentName, options.taskKind),
        ),
        generateAgentAddonPrompt(agentPromptAddon),
      ]);
    }

    return compactPrompts([
      generateBasePrompt(),
      getPrimaryTaskPrompt("agent"),
      generateAgentAddonPrompt(agentPromptAddon),
      generateSubagentRolesPrompt(options.availableSubagentRoles),
    ]);
  },

  getAgentPrompt(agentName: string): string | undefined {
    return getBuiltinAgentPrompt(agentName);
  },

  getSubagentBase(): string {
    return SUBAGENT_BASE_PROMPT;
  },

  getEnvironment(info: EnvironmentInfo, minimal = false): string {
    return generateEnvironmentPrompt({ info, minimal });
  },

  getPrimaryBase(): string {
    return generateBasePrompt();
  },
};

async function resolveAgentName(
  input: SystemPromptProviderInput,
  options: SystemPromptProviderOptions,
): Promise<string> {
  const resolved = await options.agentNameResolver?.(input);
  if (resolved && resolved.trim() !== "") {
    return resolved;
  }
  return input.isSubagent ? "subagent" : "build";
}

export function createSystemPromptProvider(
  options: SystemPromptProviderOptions = {},
): SystemPromptProvider {
  return {
    async build(input: SystemPromptProviderInput): Promise<string> {
      const agentName = await resolveAgentName(input, options);
      const [availableSubagentRoles, taskKind, agentPromptAddon] =
        await Promise.all([
          input.isSubagent
            ? []
            : (options.availableSubagentRolesProvider?.(input) ?? []),
          options.taskKindResolver?.(input, agentName),
          options.agentPromptResolver?.(agentName, input),
        ]);

      return SystemPrompt.assemble({
        agentName,
        agentPromptAddon,
        availableSubagentRoles,
        isSubagent: input.isSubagent,
        taskKind,
      }).join("\n\n");
    },

    async detectEnvironment(
      input: SystemPromptProviderInput,
    ): Promise<EnvironmentInfo> {
      return options.environmentDetector
        ? options.environmentDetector(input.directory, input)
        : detectEnvironment(input.directory);
    },
  };
}
