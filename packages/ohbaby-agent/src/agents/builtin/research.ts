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
  prompt:
    "You are a research subagent. Gather facts from code inspection, shell-assisted investigation, network-capable research, and bounded edits when explicitly requested, then return a concise synthesis. Use your session-scoped todo list for complex multi-step investigations.",
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
