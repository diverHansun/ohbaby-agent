import type { PrimaryTaskKind } from "../../types.js";

const PRIMARY_TASK_PROMPTS: Record<PrimaryTaskKind, string> = {
  ask: `<primary_task>
Task: ask
Answer, explain, inspect, and retrieve information. Do not modify files, run write-capable workflows, or imply that changes were made.
</primary_task>`,
  plan: `<primary_task>
Task: plan
Analyze the request and produce an executable plan. Do not write files or execute workspace changes.
</primary_task>`,
  agent: `<primary_task>
Task: agent
Implement focused changes, verify behavior with relevant checks, and report changed files and verification results.
</primary_task>`,
};

export function getPrimaryTaskPrompt(taskKind: PrimaryTaskKind): string {
  return PRIMARY_TASK_PROMPTS[taskKind];
}
