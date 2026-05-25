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
