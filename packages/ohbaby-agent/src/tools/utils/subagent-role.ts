import {
  DEFAULT_SUBAGENT_ROLE,
  formatSubagentRoles,
  SUBAGENT_ROLES,
  type SubagentRole,
} from "../../agents/roles.js";
import { optionalEnum, ToolParameterError } from "./params.js";

const LEGACY_AGENT_NAME_PARAM = "agent_name";

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
  if (Object.prototype.hasOwnProperty.call(params, LEGACY_AGENT_NAME_PARAM)) {
    throw new ToolParameterError(
      [
        'Parameter "agent_name" is no longer supported.',
        `Use role for one of: ${formatSubagentRoles()}.`,
        "Use name for the displayed subagent instance name.",
        'Use description for UI/log descriptive role text such as "AI Events Researcher".',
      ].join(" "),
    );
  }
  return optionalEnum(params, "role", SUBAGENT_ROLES, {
    defaultValue: DEFAULT_SUBAGENT_ROLE,
    invalidMessage: invalidSubagentRoleMessage,
  });
}
