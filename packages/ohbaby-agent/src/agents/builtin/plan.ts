import type { AgentConfig } from "../types.js";

export const planAgent: AgentConfig = {
  color: "#4A90D9",
  description: "Read-only agent for analysis and planning.",
  maxSteps: 1000,
  mode: "primary",
  name: "plan",
  permission: {
    bash: {
      "*": "ask",
      "git diff*": "allow",
      "git log*": "allow",
      "git status*": "allow",
      "ls*": "allow",
    },
    edit: "deny",
    web: "allow",
  },
  tools: {
    include: [
      "read",
      "list",
      "glob",
      "grep",
      "todo_read",
      "todo_write",
      "web_fetch",
      "web_search",
      "memory_list",
      "skill",
      "skill_resource",
      "select_tools",
    ],
  },
};
