import { classifyShellCommand } from "../shell/command-classifier.js";
import { parseCommand } from "../utils/index.js";
import type { PermissionCall, PermissionToolCategory } from "./types.js";

export type PermissionCallKind =
  | "readonly"
  | "write"
  | "dangerous"
  | "network"
  | "memory-write"
  | "sensitive"
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
  bash: "dangerous",
  edit: "write",
  glob: "readonly",
  grep: "readonly",
  list: "readonly",
  read: "readonly",
  skill: "skill",
  subagent_close: "subagent",
  subagent_run: "subagent",
  subagent_status: "subagent",
  todo_read: "readonly",
  todo_write: "write",
  web_fetch: "network",
  web_search: "network",
  write: "write",
};

const SUBAGENT_TOOLS = new Set([
  "subagent_run",
  "subagent_status",
  "subagent_close",
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

  if (toolName === "bash") {
    const bash = classifyShellCommand(parseCommand(bashCommand(call)));
    return {
      bash,
      category: "dangerous",
      kind: `bash-${bash}`,
    };
  }

  if (toolName === "todo_write") {
    return { category: "write", kind: "memory-write" };
  }
  if (SUBAGENT_TOOLS.has(toolName) || call.category === "subagent") {
    return { category: "subagent", kind: "subagent" };
  }
  if (toolName === "sensitive_path") {
    return { category: "dangerous", kind: "sensitive" };
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
