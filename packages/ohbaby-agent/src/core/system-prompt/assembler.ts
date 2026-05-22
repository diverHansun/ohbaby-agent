import type { SystemPromptProvider } from "../context/index.js";
import {
  detectEnvironment,
  generateAgentPrompt,
  generateCustomInstructionsPrompt,
  generateEnvironmentPrompt,
  generateIdentityPrompt,
  loadCustomInstructions,
} from "./layers/index.js";
import {
  GENERIC_SUBAGENT_PROMPT,
  getBuiltinAgentPrompt,
} from "./prompts/agents/index.js";
import type { AssembleOptions, EnvironmentInfo } from "./types.js";
import type { PromptSecurityFinding } from "./security/index.js";

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

export const SystemPrompt = {
  assemble(options: AssembleOptions): string[] {
    assertAssembleOptions(options);
    const isSubagent = options.isSubagent;

    if (isSubagent) {
      return compactPrompts([
        generateAgentPrompt(options.agentPrompt ?? ""),
        generateEnvironmentPrompt({
          info: options.environment,
          minimal: true,
          tools: options.tools,
        }),
      ]);
    }

    return compactPrompts([
      generateIdentityPrompt(),
      generateEnvironmentPrompt({
        info: options.environment,
        minimal: false,
        tools: options.tools,
      }),
      options.agentPrompt ? generateAgentPrompt(options.agentPrompt) : "",
      generateCustomInstructionsPrompt(options.customInstructions ?? []),
    ]);
  },

  getAgentPrompt(agentName: string): string | undefined {
    return getBuiltinAgentPrompt(agentName);
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

async function resolveAgentPrompt(
  agentName: string,
  input: SystemPromptProviderInput,
  options: SystemPromptProviderOptions,
): Promise<string> {
  const resolved = await options.agentPromptResolver?.(agentName, input);
  return (
    resolved ??
    SystemPrompt.getAgentPrompt(agentName) ??
    GENERIC_SUBAGENT_PROMPT
  );
}

export function createSystemPromptProvider(
  options: SystemPromptProviderOptions = {},
): SystemPromptProvider {
  return {
    async build(input: SystemPromptProviderInput): Promise<string> {
      const agentName = await resolveAgentName(input, options);
      const [environment, tools] = await Promise.all([
        options.environmentDetector
          ? options.environmentDetector(input.directory, input)
          : detectEnvironment(input.directory),
        options.toolsProvider?.(input) ?? [],
      ]);

      if (input.isSubagent) {
        const agentPrompt = await resolveAgentPrompt(agentName, input, options);
        return SystemPrompt.assemble({
          agentName,
          agentPrompt,
          environment,
          isSubagent: true,
          tools,
        }).join("\n\n");
      }

      const agentPrompt = await options.agentPromptResolver?.(agentName, input);
      const customInstructions = await (options.customInstructionLoader
        ? options.customInstructionLoader(input)
        : loadCustomInstructions({
            onSecurityFinding: options.onSecurityFinding,
            onWarning: options.onWarning,
            projectDirectory: input.directory,
          }));

      return SystemPrompt.assemble({
        agentName,
        agentPrompt,
        customInstructions,
        environment,
        isSubagent: false,
        tools,
      }).join("\n\n");
    },
  };
}
