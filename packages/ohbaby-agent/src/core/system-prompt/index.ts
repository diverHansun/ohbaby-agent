export { SystemPrompt, createSystemPromptProvider } from "./assembler.js";
export { GENERIC_SUBAGENT_PROMPT } from "./prompts/agents/index.js";
export {
  detectEnvironment,
  generateCustomInstructionsPrompt,
  generateEnvironmentPrompt,
  generateIdentityPrompt,
} from "./layers/index.js";
export {
  CUSTOM_INSTRUCTIONS_FILE_NAME,
  GLOBAL_CUSTOM_CONFIG_DIR,
  MAX_CUSTOM_INSTRUCTION_CHARS,
  PROJECT_CUSTOM_CONFIG_DIR,
  getGlobalCustomInstructionsPath,
  getProjectConfigCustomInstructionsPath,
  getProjectCustomInstructionsPath,
  loadCustomInstructions,
} from "./services/custom-instruction-loader.js";
export type {
  SystemPromptProviderInput,
  SystemPromptProviderOptions,
} from "./assembler.js";
export type { AssembleOptions, EnvironmentInfo, LayerType } from "./types.js";
export type { CustomInstructionLoadOptions } from "./services/custom-instruction-loader.js";
