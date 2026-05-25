import type { SubagentTaskKind } from "../../types.js";

const SUBAGENT_TASK_PROMPTS: Record<SubagentTaskKind, string> = {
  explore: `<subagent_task>
Task: explore
Code exploration task: quickly find, inspect, and summarize relevant code. Prefer targeted search before reading large files.
</subagent_task>`,
  research: `<subagent_task>
Task: research
Research task: investigate a bounded question, separate confirmed facts from inferences, and return a concise synthesis.
</subagent_task>`,
  plan: `<subagent_task>
Task: plan
Planning task: analyze a bounded child task and return a concise implementation plan. Do not create more subagents.
</subagent_task>`,
  generic: `<subagent_task>
Task: generic
Complete the delegated bounded task independently and return a concise result to the primary agent.
</subagent_task>`,
};

export function getSubagentTaskPrompt(taskKind: SubagentTaskKind): string {
  return SUBAGENT_TASK_PROMPTS[taskKind];
}
