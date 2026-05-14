import type { Tool } from "../core/tool-scheduler/index.js";
import { createFileTools } from "./file-tools.js";
import {
  createTodoTools,
  InMemoryTodoStore,
  type TodoStore,
} from "./todo-tools.js";

export interface BuiltinToolsOptions {
  readonly todoStore?: TodoStore;
}

export function createBuiltinTools(options: BuiltinToolsOptions = {}): Tool[] {
  const todoStore = options.todoStore ?? new InMemoryTodoStore();
  return [...createFileTools(), ...createTodoTools(todoStore)];
}

export const BUILTIN_TOOLS: readonly Tool[] = createBuiltinTools();
