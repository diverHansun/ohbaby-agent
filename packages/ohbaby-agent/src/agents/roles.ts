export const DEFAULT_SUBAGENT_ROLE = "generic" as const;

export const SUBAGENT_ROLES = [
  DEFAULT_SUBAGENT_ROLE,
  "explore",
  "research",
] as const;

export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

export function isSubagentRole(value: string): value is SubagentRole {
  return (SUBAGENT_ROLES as readonly string[]).includes(value);
}

export function formatSubagentRoles(): string {
  return SUBAGENT_ROLES.join(", ");
}
