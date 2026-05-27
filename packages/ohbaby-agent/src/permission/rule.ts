import type { PermissionRule } from "./types.js";

export interface ParsedPermissionPattern {
  readonly tool: string;
  readonly pattern?: string;
}

function canonical(value: string): string {
  return value.trim().toLowerCase();
}

export function parsePermissionPattern(input: string): ParsedPermissionPattern {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Permission pattern is required.");
  }

  const match = /^([a-z0-9_./-]+)(?:\(([^()]*)\))?$/iu.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid permission pattern: ${input}`);
  }

  const tool = canonical(match[1]);
  const rawPattern = match.at(2);
  const pattern = rawPattern === undefined ? undefined : canonical(rawPattern);
  if (pattern === undefined || pattern === "") {
    return { tool };
  }
  return { pattern, tool };
}

export function formatPermissionRule(rule: PermissionRule): string {
  return `${formatPermissionPattern(rule)} -> ${rule.decision}`;
}

export function formatPermissionPattern(
  input: ParsedPermissionPattern,
): string {
  const tool = canonical(input.tool);
  const pattern =
    input.pattern && input.pattern.trim() !== ""
      ? `(${canonical(input.pattern)})`
      : "";
  return `${tool}${pattern}`;
}
