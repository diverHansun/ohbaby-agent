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
import { createTaskTool } from "./task-tool.js";
import { createWebTools, type WebToolsOptions } from "./web-tools.js";
import type { TaskExecutor } from "../core/agents/index.js";

export interface BuiltinToolsOptions {
  readonly shell?: BashShell;
  readonly spawn?: SpawnCommand;
  readonly searchProvider?: WebToolsOptions;
  readonly todoStore?: TodoStore;
  readonly taskExecutor?: TaskExecutor;
}

export function createBuiltinTools(options: BuiltinToolsOptions = {}): Tool[] {
  const todoStore = options.todoStore ?? new InMemoryTodoStore();
  const tools = [
    ...createFileTools(),
    ...createTodoTools(todoStore),
    ...createWebTools(options.searchProvider),
    createBashTool({ shell: options.shell, spawn: options.spawn }),
  ];
  if (options.taskExecutor) {
    tools.push(createTaskTool(options.taskExecutor));
  }
  return tools;
}

export const BUILTIN_TOOLS: readonly Tool[] = createBuiltinTools();
