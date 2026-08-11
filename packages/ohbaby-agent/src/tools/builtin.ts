import type { Tool } from "../core/tool-scheduler/index.js";
import { createBashTool, type BashShell, type SpawnCommand } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { createListTool } from "./list.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import {
  createTodoTools,
  InMemoryTodoStore,
  type TodoStore,
  type TodoToolOptions,
} from "./todo.js";
import { createSubagentTools, type SubagentToolHost } from "./subagent.js";
import { createWebTools, type WebToolsOptions } from "./web.js";
import { createGoalTools, type GoalToolBackend } from "../goals/tools.js";
import {
  createTaskKillTool,
  createTaskOutputTool,
  ShellJobRegistry,
} from "./shell-job-registry.js";
import { Shell } from "../shell/index.js";

export interface BuiltinToolsOptions {
  readonly shell?: BashShell;
  readonly spawn?: SpawnCommand;
  readonly searchProvider?: WebToolsOptions;
  readonly todoStore?: TodoStore;
  readonly todoToolOptions?: TodoToolOptions;
  readonly subagentHost?: SubagentToolHost;
  readonly goalBackend?: GoalToolBackend;
  readonly shellJobRegistry?: ShellJobRegistry;
}

export function createBuiltinTools(options: BuiltinToolsOptions = {}): Tool[] {
  const todoStore = options.todoStore ?? new InMemoryTodoStore();
  const shellJobRegistry =
    options.shellJobRegistry ??
    new ShellJobRegistry({
      killTree: (child): Promise<void> | void =>
        (options.shell ?? Shell).killTree(child),
    });
  const tools = [
    createReadTool(),
    createListTool(),
    createGlobTool(),
    createGrepTool(),
    createWriteTool(),
    createEditTool(),
    ...createTodoTools(todoStore, options.todoToolOptions),
    ...createWebTools(options.searchProvider),
    createBashTool({
      registry: shellJobRegistry,
      shell: options.shell,
      spawn: options.spawn,
    }),
    createTaskOutputTool(shellJobRegistry),
    createTaskKillTool(shellJobRegistry),
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
