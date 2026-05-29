import type { SystemPromptProvider } from "../context/index.js";
import {
  detectEnvironment,
  generateCustomInstructionsPrompt,
  generateEnvironmentPrompt,
  generateIdentityPrompt,
  generateToolGuidancePrompt,
  loadCustomInstructions,
} from "./layers/index.js";
import { getBuiltinAgentPrompt } from "./prompts/agents/index.js";
import { getPrimaryTaskPrompt } from "./prompts/primary/tasks.js";
import { SUBAGENT_BASE_PROMPT } from "./prompts/subagents/base.js";
import { getSubagentTaskPrompt } from "./prompts/subagents/tasks.js";
import {
  scanPromptLikeContent,
  shouldLoadPromptLikeContent,
  type PromptSecurityFinding,
} from "./security/index.js";
import type {
  AssembleOptions,
  EnvironmentInfo,
  PrimaryTaskKind,
  PromptTaskKind,
  SubagentTaskKind,
} from "./types.js";

export interface SystemPromptProviderInput {
  readonly sessionId: string;
  readonly directory: string;
  readonly isSubagent: boolean;
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
  readonly taskKindResolver?: (
    input: SystemPromptProviderInput,
    agentName: string,
  ) => Promise<PromptTaskKind | undefined> | PromptTaskKind | undefined;
  readonly toolDetailsProvider?: (input: SystemPromptProviderInput) =>
    | Promise<{
        readonly toolSnippets?: Readonly<Partial<Record<string, string>>>;
        readonly promptGuidelines?: readonly string[];
      }>
    | {
        readonly toolSnippets?: Readonly<Partial<Record<string, string>>>;
        readonly promptGuidelines?: readonly string[];
      };
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
  return value === "ask" || value === "plan" || value === "agent";
}

function isSubagentTaskKind(value: unknown): value is SubagentTaskKind {
  return (
    value === "explore" ||
    value === "research" ||
    value === "plan" ||
    value === "generic"
  );
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

function safeToolSnippets(
  toolSnippets: Readonly<Partial<Record<string, string>>> | undefined,
  onSecurityFinding: ((finding: PromptSecurityFinding) => void) | undefined,
): Readonly<Partial<Record<string, string>>> | undefined {
  if (!toolSnippets) {
    return undefined;
  }

  const safeEntries: [string, string][] = [];
  for (const [toolName, snippet] of Object.entries(toolSnippets)) {
    const trimmed = snippet?.trim();
    if (!trimmed) {
      continue;
    }
    const scan = scanPromptLikeContent(trimmed, {
      kind: "tool-description",
      label: `Tool ${toolName}`,
    });
    for (const finding of scan.findings) {
      onSecurityFinding?.(finding);
    }
    if (shouldLoadPromptLikeContent(scan)) {
      safeEntries.push([toolName, trimmed]);
    }
  }

  return Object.fromEntries(safeEntries);
}

export const SystemPrompt = {
  assemble(options: AssembleOptions): string[] {
    assertAssembleOptions(options);
    const isSubagent = options.isSubagent;
    const agentPromptAddon = options.agentPromptAddon ?? options.agentPrompt;
    const toolSnippets = safeToolSnippets(
      options.toolSnippets,
      options.onSecurityFinding,
    );
    const toolGuidance = generateToolGuidancePrompt({
      promptGuidelines: options.promptGuidelines,
      toolSnippets,
      tools: options.tools,
    });

    if (isSubagent) {
      return compactPrompts([
        SUBAGENT_BASE_PROMPT,
        getSubagentTaskPrompt(
          resolveSubagentTaskKind(options.agentName, options.taskKind),
        ),
        generateAgentAddonPrompt(agentPromptAddon),
        toolGuidance,
        generateEnvironmentPrompt({
          info: options.environment,
          minimal: true,
          tools: options.tools,
        }),
      ]);
    }

    return compactPrompts([
      generateIdentityPrompt(),
      getPrimaryTaskPrompt(resolvePrimaryTaskKind(options.taskKind)),
      generateAgentAddonPrompt(agentPromptAddon),
      toolGuidance,
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

  getIdentity(): string {
    return generateIdentityPrompt();
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
      const [environment, tools, taskKind, toolDetails] = await Promise.all([
        options.environmentDetector
          ? options.environmentDetector(input.directory, input)
          : detectEnvironment(input.directory),
        options.toolsProvider?.(input) ?? [],
        options.taskKindResolver?.(input, agentName),
        options.toolDetailsProvider?.(input) ?? {},
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
          onSecurityFinding: options.onSecurityFinding,
          promptGuidelines: toolDetails.promptGuidelines,
          taskKind,
          toolSnippets: toolDetails.toolSnippets,
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
        customInstructions,
        environment,
        isSubagent: false,
        onSecurityFinding: options.onSecurityFinding,
        promptGuidelines: toolDetails.promptGuidelines,
        taskKind,
        toolSnippets: toolDetails.toolSnippets,
        tools,
      }).join("\n\n");
    },
  };
}
