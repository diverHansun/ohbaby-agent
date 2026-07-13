import type { AgentConfig } from "../types.js";

export const exploreAgent: AgentConfig = {
  color: "#9B59B6",
  description:
    "Fast code exploration subagent for finding files, searching code, and analyzing project structure.",
  maxSteps: 50,
  mode: "subagent",
  name: "explore",
  permission: {
    bash: { "*": "ask" },
    edit: "ask",
    web: "deny",
  },
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
      "select_tools",
      "skill",
      "skill_resource",
    ],
  },
};
