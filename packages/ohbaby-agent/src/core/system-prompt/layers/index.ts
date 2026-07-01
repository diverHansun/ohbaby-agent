export { generateBasePrompt } from "./base.js";
export { detectEnvironment, generateEnvironmentPrompt } from "./environment.js";
export { generateToolGuidancePrompt } from "./tools.js";
export { generateCustomInstructionsPrompt } from "./custom.js";
export {
  CUSTOM_INSTRUCTIONS_FILE_NAME,
  CUSTOM_INSTRUCTIONS_FALLBACK_FILE_NAMES,
  GLOBAL_CUSTOM_CONFIG_DIR,
  MAX_CUSTOM_INSTRUCTION_CHARS,
  PROJECT_CUSTOM_CONFIG_DIR,
  getGlobalCustomInstructionsPath,
  getProjectConfigCustomInstructionsPath,
  getProjectCustomInstructionsPath,
  loadCustomInstructions,
} from "../services/custom-instruction-loader.js";
export type {
  EnvironmentDetectionOptions,
  GenerateEnvironmentPromptOptions,
} from "./environment.js";
export type { GenerateToolGuidancePromptOptions } from "./tools.js";
export type { CustomInstructionLoadOptions } from "../services/custom-instruction-loader.js";
