import type { PrimaryTaskKind } from "../../types.js";
import {
  PRIMARY_TASK_AGENT_PROMPT_TEMPLATE,
  PRIMARY_TASK_ASK_PROMPT_TEMPLATE,
  PRIMARY_TASK_PLAN_PROMPT_TEMPLATE,
} from "../templates.generated.js";

const PRIMARY_TASK_PROMPTS: Record<PrimaryTaskKind, string> = {
  agent: PRIMARY_TASK_AGENT_PROMPT_TEMPLATE,
  ask: PRIMARY_TASK_ASK_PROMPT_TEMPLATE,
  plan: PRIMARY_TASK_PLAN_PROMPT_TEMPLATE,
};

export function getPrimaryTaskPrompt(taskKind: PrimaryTaskKind): string {
  return PRIMARY_TASK_PROMPTS[taskKind];
}
