import { classifyShellCommand } from "../shell/command-policy.js";
import { parseCommand } from "../utils/index.js";
import type { PermissionCall, PermissionToolCategory } from "./types.js";

export type PermissionCallKind =
  | "readonly"
  | "write"
  | "dangerous"
  | "network"
  | "memory-read"
  | "memory-write"
  | "skill"
  | "subagent"
  | "bash-readonly"
  | "bash-mutating"
  | "bash-dangerous";

export interface PermissionClassification {
  readonly category: PermissionToolCategory;
  readonly kind: PermissionCallKind;
  readonly bash?: "readonly" | "mutating" | "dangerous";
  readonly label?: string;
}

const BUILTIN_CATEGORIES: Partial<Record<string, PermissionToolCategory>> = {
  agent_close: "subagent",
  agent_eval: "subagent",
  agent_open: "subagent",
  agent_status: "subagent",
  bash: "dangerous",
  edit: "write",
  glob: "readonly",
  grep: "readonly",
  list: "readonly",
  read: "readonly",
  skill: "skill",
  task: "subagent",
  todo_read: "readonly",
  todo_write: "write",
  web_fetch: "network",
  web_search: "network",
  write: "write",
};

const MEMORY_READ_TOOLS = new Set(["memory_read", "memory_list"]);
const MEMORY_WRITE_TOOLS = new Set([
  "memory_add",
  "memory_update",
  "memory_remove",
]);
const SUBAGENT_TOOLS = new Set([
  "task",
  "agent_open",
  "agent_eval",
  "agent_status",
  "agent_close",
  "tool/agent-task.ts",
]);

function canonicalToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function labelFromParams(
  call: PermissionCall,
  fallback: string,
): string | undefined {
  const value = call.params.name;
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : fallback;
}

function bashCommand(call: PermissionCall): string {
  const command = call.params.command;
  return typeof command === "string" ? command : "";
}

export function classifyPermissionCall(
  call: PermissionCall,
): PermissionClassification {
  const toolName = canonicalToolName(call.toolName);

  if (toolName === "bash" || "command" in call.params) {
    const bash = classifyShellCommand(parseCommand(bashCommand(call)));
    return {
      bash,
      category: "dangerous",
      kind: `bash-${bash}`,
    };
  }

  if (MEMORY_READ_TOOLS.has(toolName)) {
    return { category: "memory", kind: "memory-read" };
  }
  if (MEMORY_WRITE_TOOLS.has(toolName)) {
    return { category: "memory", kind: "memory-write" };
  }
  if (SUBAGENT_TOOLS.has(toolName) || call.category === "subagent") {
    return { category: "subagent", kind: "subagent" };
  }
  if (
    toolName === "skill" ||
    toolName.startsWith("skill_") ||
    call.category === "skill"
  ) {
    return {
      category: "skill",
      kind: "skill",
      label: labelFromParams(call, toolName),
    };
  }

  const category = call.category ?? BUILTIN_CATEGORIES[toolName] ?? "write";
  return {
    category,
    kind: category === "memory" ? "memory-write" : category,
  };
}
