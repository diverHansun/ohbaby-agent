import { GENERIC_SUBAGENT_PROMPT } from "./generic.js";
import { getSubagentTaskPrompt } from "../subagents/tasks.js";

const AGENT_PROMPTS = new Map<string, string>([
  ["explore", getSubagentTaskPrompt("explore")],
  ["research", getSubagentTaskPrompt("research")],
  ["plan", getSubagentTaskPrompt("plan")],
]);

export function getBuiltinAgentPrompt(agentName: string): string | undefined {
  return AGENT_PROMPTS.get(agentName.trim().toLowerCase());
}

export { GENERIC_SUBAGENT_PROMPT };
