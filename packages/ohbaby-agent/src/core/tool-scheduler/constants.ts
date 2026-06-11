import type { ToolCategory, ToolSchedulerConfig } from "./types.js";

const SYNC_SUBAGENT_BUDGET_MS = 300_000;
const TOOL_SCHEDULER_GUARD_BAND_MS = 10_000;

export const DEFAULT_TOOL_SCHEDULER_CONFIG: ToolSchedulerConfig = {
  concurrency: {
    maxReadConcurrency: 5,
    maxSubagentConcurrency: 3,
  },
  timeout: {
    defaultTimeout: 120_000,
    byTool: {
      // Keep the scheduler slightly longer than the sync subagent deadline so
      // the subagent can report its own timeout result before the tool wrapper
      // aborts the call.
      task: SYNC_SUBAGENT_BUDGET_MS + TOOL_SCHEDULER_GUARD_BAND_MS,
    },
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

export const SUBAGENT_DISABLED_TOOLS = new Set([
  "task",
  "agent_open",
  "agent_eval",
  "agent_status",
  "agent_close",
]);
