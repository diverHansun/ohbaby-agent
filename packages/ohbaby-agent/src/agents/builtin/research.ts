import type { AgentConfig } from "../types.js";

export const researchAgent: AgentConfig = {
  color: "#E67E22",
  description:
    "Research subagent for deeper read-only analysis, web lookup, and information synthesis.",
  maxSteps: 30,
  mode: "subagent",
  name: "research",
  permission: {
    bash: { "*": "deny" },
    edit: "deny",
    mcp: "ask",
    web: "allow",
  },
  prompt:
    "You are a research subagent. Gather facts from read-only code inspection and network-capable research, then return a concise synthesis.",
  tools: {
    include: [
      "read",
      "list",
      "glob",
      "grep",
      "web_fetch",
      "web_search",
      "memory_list",
    ],
  },
};
