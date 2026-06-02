import type {
  CommandMcpServerStatus,
  CommandMcpServerSummary,
  CommandSkillScope,
  CommandSkillSummary,
} from "./types.js";

const COMMAND_SKILL_SCOPES = new Set<string>(["project", "user"]);
const MCP_SERVER_STATUSES = new Set<string>([
  "connected",
  "disabled",
  "disconnected",
  "failed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCommandSkillScope(
  value: unknown,
): value is CommandSkillScope {
  return typeof value === "string" && COMMAND_SKILL_SCOPES.has(value);
}

export function isCommandMcpServerStatus(
  value: unknown,
): value is CommandMcpServerStatus {
  return typeof value === "string" && MCP_SERVER_STATUSES.has(value);
}

export function sanitizeCommandSkillSummary(
  skill: unknown,
): CommandSkillSummary | null {
  if (!isRecord(skill)) {
    return null;
  }
  const { description, name, scope, source } = skill;
  if (
    typeof description !== "string" ||
    typeof name !== "string" ||
    !isCommandSkillScope(scope)
  ) {
    return null;
  }
  return {
    description,
    name,
    scope,
    ...(typeof source === "string" ? { source } : {}),
  };
}

export function sanitizeCommandMcpServerSummary(
  server: unknown,
): CommandMcpServerSummary | null {
  if (!isRecord(server)) {
    return null;
  }
  const { name, status } = server;
  if (typeof name !== "string" || !isCommandMcpServerStatus(status)) {
    return null;
  }
  return { name, status };
}
