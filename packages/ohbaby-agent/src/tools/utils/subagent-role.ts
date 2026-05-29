import {
  DEFAULT_SUBAGENT_ROLE,
  formatSubagentRoles,
  SUBAGENT_ROLES,
  type SubagentRole,
} from "../../agents/roles.js";
import { optionalEnum } from "./params.js";

export function invalidSubagentRoleMessage(value: string): string {
  return [
    `Invalid subagent role: "${value}".`,
    `Allowed roles are: ${formatSubagentRoles()}. Omit role to use generic.`,
    'Use description for descriptive role text such as "AI Events Researcher".',
    "Use name for the displayed subagent instance name.",
    "build and plan are primary agents, not subagent roles.",
  ].join(" ");
}

export function subagentRoleParam(
  params: Record<string, unknown>,
): SubagentRole {
  return optionalEnum(params, "role", SUBAGENT_ROLES, {
    defaultValue: DEFAULT_SUBAGENT_ROLE,
    invalidMessage: invalidSubagentRoleMessage,
  });
}
