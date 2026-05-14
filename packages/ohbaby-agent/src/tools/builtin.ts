import type { Tool } from "../core/tool-scheduler/index.js";
import { createFileTools } from "./file-tools.js";

export type BuiltinToolsOptions = Record<string, never>;

export function createBuiltinTools(_options: BuiltinToolsOptions = {}): Tool[] {
  return [...createFileTools()];
}

export const BUILTIN_TOOLS: readonly Tool[] = createBuiltinTools();
