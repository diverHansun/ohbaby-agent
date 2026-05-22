import type { AgentConfig } from "../types.js";

export const exploreAgent: AgentConfig = {
  color: "#9B59B6",
  description:
    "Fast code exploration subagent for finding files, searching code, and analyzing project structure.",
  maxSteps: 15,
  mode: "subagent",
  name: "explore",
  permission: {
    bash: { "*": "ask" },
    edit: "ask",
    mcp: "deny",
    web: "deny",
  },
  prompt:
    "You are a focused code exploration subagent. Find relevant files and summarize the useful facts. You may use shell, edit, and write tools when the parent explicitly asks for workspace changes; otherwise prefer read-only exploration. Use your session-scoped todo list for complex multi-step investigations.",
  tools: {
    include: [
      "read",
      "list",
      "glob",
      "grep",
      "write",
      "edit",
      "bash",
      "todo_read",
      "todo_write",
      "memory_list",
    ],
  },
};
