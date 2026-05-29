import type { SubagentTaskKind } from "../../types.js";
import {
  SUBAGENT_TASK_EXPLORE_PROMPT_TEMPLATE,
  SUBAGENT_TASK_GENERIC_PROMPT_TEMPLATE,
  SUBAGENT_TASK_RESEARCH_PROMPT_TEMPLATE,
} from "../templates.generated.js";

const SUBAGENT_TASK_PROMPTS: Record<SubagentTaskKind, string> = {
  explore: SUBAGENT_TASK_EXPLORE_PROMPT_TEMPLATE,
  generic: SUBAGENT_TASK_GENERIC_PROMPT_TEMPLATE,
  research: SUBAGENT_TASK_RESEARCH_PROMPT_TEMPLATE,
};

export function getSubagentTaskPrompt(taskKind: SubagentTaskKind): string {
  return SUBAGENT_TASK_PROMPTS[taskKind];
}
