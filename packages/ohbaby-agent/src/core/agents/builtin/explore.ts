import type { AgentConfig } from "../types.js";

export const exploreAgent: AgentConfig = {
  color: "#9B59B6",
  description:
    "Fast code exploration subagent for finding files, searching code, and analyzing project structure.",
  maxSteps: 15,
  mode: "subagent",
  name: "explore",
  permission: {
    bash: { "*": "deny" },
    edit: "deny",
    mcp: "deny",
    web: "deny",
  },
  prompt:
    "You are a focused code exploration subagent. Find relevant files and summarize the useful facts without modifying the workspace.",
  tools: {
    include: ["read", "list", "glob", "grep", "memory_list"],
  },
};
