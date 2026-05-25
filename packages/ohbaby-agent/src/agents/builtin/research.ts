import type { AgentConfig } from "../types.js";

export const researchAgent: AgentConfig = {
  color: "#E67E22",
  description:
    "Research subagent for deeper code inspection, web lookup, bounded workspace help, and information synthesis.",
  maxSteps: 30,
  mode: "subagent",
  name: "research",
  permission: {
    bash: { "*": "ask" },
    edit: "ask",
    mcp: "ask",
    web: "allow",
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
      "web_fetch",
      "web_search",
      "memory_list",
    ],
  },
};
