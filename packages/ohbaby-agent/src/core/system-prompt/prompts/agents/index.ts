import { EXPLORE_PROMPT } from "./explore.js";
import { GENERIC_SUBAGENT_PROMPT } from "./generic.js";
import { RESEARCH_PROMPT } from "./research.js";

const AGENT_PROMPTS = new Map<string, string>([
  ["explore", EXPLORE_PROMPT],
  ["research", RESEARCH_PROMPT],
]);

export function getBuiltinAgentPrompt(agentName: string): string | undefined {
  return AGENT_PROMPTS.get(agentName.trim().toLowerCase());
}

export { EXPLORE_PROMPT, GENERIC_SUBAGENT_PROMPT, RESEARCH_PROMPT };
