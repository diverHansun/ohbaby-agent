import type { AgentConfig } from "../types.js";

export const buildAgent: AgentConfig = {
  color: "#00A67E",
  default: true,
  description: "Full-featured development agent with all capabilities.",
  maxSteps: 50,
  mode: "primary",
  name: "build",
  permission: {
    bash: { "*": "allow" },
    edit: "allow",
    mcp: "ask",
    web: "allow",
  },
};
