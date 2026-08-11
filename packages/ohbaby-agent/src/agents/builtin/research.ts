import type { AgentConfig } from "../types.js";

export const researchAgent: AgentConfig = {
  color: "#E67E22",
  description:
    "Research subagent for deeper code inspection, web lookup, bounded workspace help, and information synthesis.",
  maxSteps: 100,
  mode: "subagent",
  name: "research",
  permission: {
    bash: { "*": "ask" },
    edit: "ask",
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
      "task_output",
      "task_kill",
      "todo_read",
      "todo_write",
      "web_fetch",
      "web_search",
      "select_tools",
      "skill",
      "skill_resource",
    ],
  },
};
