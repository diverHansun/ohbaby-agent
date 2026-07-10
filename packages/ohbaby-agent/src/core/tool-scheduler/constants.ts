import type { ToolCategory, ToolSchedulerConfig } from "./types.js";

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
  subagent_run: "subagent",
  subagent_status: "subagent-control",
  subagent_close: "subagent-control",
};

export const SUBAGENT_DISABLED_TOOLS = new Set([
  "subagent_run",
  "subagent_status",
  "subagent_close",
]);
