import { buildAgent } from "./build.js";
import { exploreAgent } from "./explore.js";
import { genericAgent } from "./generic.js";
import { planAgent } from "./plan.js";
import { researchAgent } from "./research.js";
import type { AgentConfig } from "../types.js";

export const BUILTIN_AGENT_NAMES = [
  "build",
  "plan",
  "generic",
  "explore",
  "research",
] as const;

export const BUILTIN_AGENTS: readonly AgentConfig[] = [
  buildAgent,
  planAgent,
  genericAgent,
  exploreAgent,
  researchAgent,
];

export { buildAgent, exploreAgent, genericAgent, planAgent, researchAgent };
