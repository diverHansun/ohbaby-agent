import type { ToolCategory, ToolMode, ToolSchedulerConfig } from "./types.js";

export const DEFAULT_TOOL_SCHEDULER_CONFIG: ToolSchedulerConfig = {
  concurrency: {
    maxReadConcurrency: 5,
    maxSubagentConcurrency: 3,
  },
  timeout: {
    defaultTimeout: 120_000,
  },
};

export const BUILTIN_TOOL_CATEGORIES: Record<string, ToolCategory> = {
  read: "readonly",
  glob: "readonly",
  grep: "readonly",
  list: "readonly",
  todo_read: "readonly",
  write: "write",
  edit: "write",
  todo_write: "write",
  bash: "dangerous",
  web_fetch: "network",
  web_search: "network",
  memory_list: "memory",
  memory_add: "memory",
  memory_update: "memory",
  memory_remove: "memory",
  skill: "skill",
  task: "subagent",
  agent_open: "subagent",
  agent_eval: "subagent",
  agent_status: "subagent",
  agent_close: "subagent",
};

export const MODE_ALLOWED_CATEGORIES: Record<
  ToolMode,
  readonly ToolCategory[]
> = {
  ask: ["readonly", "network", "memory", "skill"],
  plan: ["readonly", "network", "memory", "skill"],
  agent: [
    "readonly",
    "write",
    "dangerous",
    "network",
    "memory",
    "skill",
    "subagent",
  ],
};

export const SUBAGENT_DISABLED_TOOLS = new Set([
  "task",
  "agent_open",
  "agent_eval",
  "agent_status",
  "agent_close",
]);
