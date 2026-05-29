import type { AgentConfig } from "../types.js";
import { DEFAULT_SUBAGENT_ROLE } from "../roles.js";

export const genericAgent: AgentConfig = {
  color: "#4F8EF7",
  description:
    "Default general-purpose subagent for broad workspace tasks when no specialized role is required.",
  maxSteps: 30,
  mode: "subagent",
  name: DEFAULT_SUBAGENT_ROLE,
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
