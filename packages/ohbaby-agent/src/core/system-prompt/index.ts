export { SystemPrompt, createSystemPromptProvider } from "./assembler.js";
export { GENERIC_SUBAGENT_PROMPT } from "./prompts/agents/index.js";
export {
  CUSTOM_INSTRUCTIONS_FILE_NAME,
  GLOBAL_CUSTOM_CONFIG_DIR,
  MAX_CUSTOM_INSTRUCTION_CHARS,
  PROJECT_CUSTOM_CONFIG_DIR,
  detectEnvironment,
  generateCustomInstructionsPrompt,
  generateEnvironmentPrompt,
  generateIdentityPrompt,
  getGlobalCustomInstructionsPath,
  getProjectConfigCustomInstructionsPath,
  getProjectCustomInstructionsPath,
  loadCustomInstructions,
} from "./layers/index.js";
export type {
  SystemPromptProviderInput,
  SystemPromptProviderOptions,
} from "./assembler.js";
export type { AssembleOptions, EnvironmentInfo, LayerType } from "./types.js";
