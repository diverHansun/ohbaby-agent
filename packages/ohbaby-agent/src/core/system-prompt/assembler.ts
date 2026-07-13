import type { SystemPromptProvider } from "../context/index.js";
import {
  detectEnvironment,
  generateBasePrompt,
  generateCustomInstructionsPrompt,
  generateEnvironmentPrompt,
  generateMcpToolMenuPrompt,
} from "./layers/index.js";
import { getBuiltinAgentPrompt } from "./prompts/agents/index.js";
import { getPrimaryTaskPrompt } from "./prompts/primary/tasks.js";
import { SUBAGENT_ROLES_GUIDANCE_PROMPT } from "./prompts/primary/subagent-roles.js";
import { SUBAGENT_BASE_PROMPT } from "./prompts/subagents/base.js";
import { getSubagentTaskPrompt } from "./prompts/subagents/tasks.js";
import { loadCustomInstructions } from "./services/custom-instruction-loader.js";
import type { PromptSecurityFinding } from "./security/index.js";
import type {
  AssembleOptions,
  EnvironmentInfo,
  PrimaryTaskKind,
  PromptTaskKind,
  SubagentRolePromptInfo,
  SubagentTaskKind,
} from "./types.js";

export interface SystemPromptProviderInput {
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly directory: string;
  readonly isSubagent: boolean;
  readonly agentName?: string;
}

export interface SystemPromptProviderOptions {
  readonly agentNameResolver?: (
    input: SystemPromptProviderInput,
  ) => Promise<string | undefined> | string | undefined;
  readonly agentPromptResolver?: (
    agentName: string,
    input: SystemPromptProviderInput,
  ) => Promise<string | undefined> | string | undefined;
  readonly customInstructionLoader?: (
    input: SystemPromptProviderInput,
  ) => Promise<readonly string[]> | readonly string[];
  readonly environmentDetector?: (
    directory: string,
    input: SystemPromptProviderInput,
  ) => Promise<EnvironmentInfo> | EnvironmentInfo;
  readonly onWarning?: (message: string, error?: unknown) => void;
  readonly onSecurityFinding?: (finding: PromptSecurityFinding) => void;
  readonly toolsProvider?: (
    input: SystemPromptProviderInput,
  ) => Promise<readonly string[]> | readonly string[];
  readonly mcpToolNamesProvider?: (
    input: SystemPromptProviderInput,
  ) => Promise<readonly string[]> | readonly string[];
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

function isPrimaryTaskKind(value: unknown): value is PrimaryTaskKind {
  return value === "plan" || value === "agent";
}

function isSubagentTaskKind(value: unknown): value is SubagentTaskKind {
  return value === "explore" || value === "research" || value === "generic";
}

function resolvePrimaryTaskKind(
  taskKind: PromptTaskKind | undefined,
): PrimaryTaskKind {
  return isPrimaryTaskKind(taskKind) ? taskKind : "agent";
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
    const mcpToolMenu = generateMcpToolMenuPrompt({
      toolNames: options.mcpToolNames,
    });

    if (isSubagent) {
      return compactPrompts([
        SUBAGENT_BASE_PROMPT,
        getSubagentTaskPrompt(
          resolveSubagentTaskKind(options.agentName, options.taskKind),
        ),
        generateAgentAddonPrompt(agentPromptAddon),
        mcpToolMenu,
        generateEnvironmentPrompt({
          info: options.environment,
          minimal: true,
          tools: options.tools,
        }),
      ]);
    }

    return compactPrompts([
      generateBasePrompt(),
      getPrimaryTaskPrompt(resolvePrimaryTaskKind(options.taskKind)),
      generateAgentAddonPrompt(agentPromptAddon),
      generateSubagentRolesPrompt(options.availableSubagentRoles),
      mcpToolMenu,
      generateEnvironmentPrompt({
        info: options.environment,
        minimal: false,
        tools: options.tools,
      }),
      generateCustomInstructionsPrompt(options.customInstructions ?? []),
    ]);
  },

  getAgentPrompt(agentName: string): string | undefined {
    return getBuiltinAgentPrompt(agentName);
  },

  getSubagentBase(): string {
    return SUBAGENT_BASE_PROMPT;
  },

  getEnvironment(
    info: EnvironmentInfo,
    minimal = false,
    tools?: readonly string[],
  ): string {
    return generateEnvironmentPrompt({ info, minimal, tools });
  },

  getPrimaryBase(): string {
    return generateBasePrompt();
  },

  loadCustomInstructions,
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

async function resolveAgentPromptAddon(
  agentName: string,
  input: SystemPromptProviderInput,
  options: SystemPromptProviderOptions,
): Promise<string | undefined> {
  return await options.agentPromptResolver?.(agentName, input);
}

export function createSystemPromptProvider(
  options: SystemPromptProviderOptions = {},
): SystemPromptProvider {
  return {
    async build(input: SystemPromptProviderInput): Promise<string> {
      const agentName = await resolveAgentName(input, options);
      const [
        availableSubagentRoles,
        environment,
        mcpToolNames,
        tools,
        taskKind,
      ] = await Promise.all([
        input.isSubagent
          ? []
          : (options.availableSubagentRolesProvider?.(input) ?? []),
        options.environmentDetector
          ? options.environmentDetector(input.directory, input)
          : detectEnvironment(input.directory),
        options.mcpToolNamesProvider?.(input) ?? [],
        options.toolsProvider?.(input) ?? [],
        options.taskKindResolver?.(input, agentName),
      ]);
      const agentPromptAddon = await resolveAgentPromptAddon(
        agentName,
        input,
        options,
      );

      if (input.isSubagent) {
        return SystemPrompt.assemble({
          agentName,
          agentPromptAddon,
          environment,
          isSubagent: true,
          mcpToolNames,
          taskKind,
          tools,
        }).join("\n\n");
      }

      const customInstructions = await (options.customInstructionLoader
        ? options.customInstructionLoader(input)
        : loadCustomInstructions({
            onSecurityFinding: options.onSecurityFinding,
            onWarning: options.onWarning,
            projectDirectory: input.directory,
          }));

      return SystemPrompt.assemble({
        agentName,
        agentPromptAddon,
        availableSubagentRoles,
        customInstructions,
        environment,
        isSubagent: false,
        mcpToolNames,
        taskKind,
        tools,
      }).join("\n\n");
    },
  };
}
