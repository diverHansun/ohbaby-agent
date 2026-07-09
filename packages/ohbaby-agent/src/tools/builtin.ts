import type { Tool } from "../core/tool-scheduler/index.js";
import { createBashTool, type BashShell, type SpawnCommand } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createListTool } from "./list.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { createTodoTools, InMemoryTodoStore, type TodoStore } from "./todo.js";
import { createSubagentTools, type SubagentToolHost } from "./subagent.js";
import { createWebTools, type WebToolsOptions } from "./web.js";
import { createGoalTools, type GoalToolBackend } from "../goals/tools.js";

export interface BuiltinToolsOptions {
  readonly shell?: BashShell;
  readonly spawn?: SpawnCommand;
  readonly searchProvider?: WebToolsOptions;
  readonly todoStore?: TodoStore;
  readonly subagentHost?: SubagentToolHost;
  readonly goalBackend?: GoalToolBackend;
}

export function createBuiltinTools(options: BuiltinToolsOptions = {}): Tool[] {
  const todoStore = options.todoStore ?? new InMemoryTodoStore();
  const tools = [
    createReadTool(),
    createListTool(),
    createGlobTool(),
    createGrepTool(),
    createWriteTool(),
    createEditTool(),
    ...createTodoTools(todoStore),
    ...createWebTools(options.searchProvider),
    createBashTool({ shell: options.shell, spawn: options.spawn }),
  ];
  if (options.subagentHost) {
    tools.push(...createSubagentTools(options.subagentHost));
  }
  if (options.goalBackend) {
    tools.push(...createGoalTools(options.goalBackend));
  }
  return tools;
}

export const BUILTIN_TOOLS: readonly Tool[] = createBuiltinTools();
