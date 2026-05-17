import type { Tool } from "../core/tool-scheduler/index.js";
import {
  createBashTool,
  type BashShell,
  type SpawnCommand,
} from "./bash-tool.js";
import { createFileTools } from "./file-tools.js";
import {
  createTodoTools,
  InMemoryTodoStore,
  type TodoStore,
} from "./todo-tools.js";
import { createWebTools, type WebToolsOptions } from "./web-tools.js";

export interface BuiltinToolsOptions {
  readonly shell?: BashShell;
  readonly spawn?: SpawnCommand;
  readonly searchProvider?: WebToolsOptions;
  readonly todoStore?: TodoStore;
}

export function createBuiltinTools(options: BuiltinToolsOptions = {}): Tool[] {
  const todoStore = options.todoStore ?? new InMemoryTodoStore();
  return [
    ...createFileTools(),
    ...createTodoTools(todoStore),
    ...createWebTools(options.searchProvider),
    createBashTool({ shell: options.shell, spawn: options.spawn }),
  ];
}

export const BUILTIN_TOOLS: readonly Tool[] = createBuiltinTools();
