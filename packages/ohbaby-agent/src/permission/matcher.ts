import { matchesPattern } from "../utils/index.js";
import { parsePermissionPattern } from "./rule.js";
import type {
  PermissionCall,
  PermissionPatternInput,
  PermissionRule,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringParam(
  params: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function normalizeSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}

function directoryOf(path: string): string | undefined {
  const normalized = normalizeSlashes(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return undefined;
  }
  return normalized.slice(0, index);
}

function commandParts(
  command: string,
): readonly [string | undefined, string | undefined] {
  const [head, subcommand] = command
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  return [head, subcommand];
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function wildcardToRegex(pattern: string): RegExp {
  let regex = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        regex += ".*";
        index += 1;
      } else {
        regex += "[^:]*";
      }
      continue;
    }
    regex += escapeRegex(char);
  }
  return new RegExp(`^${regex}$`);
}

function globToRegex(pattern: string): RegExp {
  let regex = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        regex += ".*";
        index += 1;
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    regex += escapeRegex(char);
  }
  return new RegExp(`^${regex}$`, "u");
}

function canonicalToolName(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function effectiveToolName(call: PermissionCall): string {
  const toolName = canonicalToolName(call.toolName);
  if (toolName === "external_directory") {
    return "external_directory";
  }
  if (toolName === "bash" || "command" in call.params) {
    return "bash";
  }
  if (
    call.category === "skill" ||
    toolName === "skill" ||
    toolName.startsWith("skill_")
  ) {
    return "skill";
  }
  return toolName;
}

function canonicalPath(input: string): string {
  return normalizeSlashes(input).trim().toLowerCase();
}

function commandParam(params: Record<string, unknown>): string | undefined {
  return getStringParam(params, ["command"])?.toLowerCase();
}

function pathParam(params: Record<string, unknown>): string | undefined {
  return getStringParam(params, ["file_path", "filePath", "path"]);
}

export function generatePermissionPattern(
  input: PermissionPatternInput,
): string {
  if (input.type === "tool") {
    const name = canonicalToolName(input.name);
    if (name === "edit" || name === "write") {
      const filePath = getStringParam(input.params, [
        "file_path",
        "filePath",
        "path",
      ]);
      const dir = filePath ? directoryOf(filePath) : undefined;
      if (dir) {
        return `${name}(${canonicalPath(dir)}/**)`;
      }
    }
    return name;
  }

  if (input.type === "bash") {
    const command = getStringParam(input.params, ["command"]) ?? input.name;
    const normalizedCommand = normalizeCommand(command).toLowerCase();
    const [head] = commandParts(normalizedCommand);
    const pattern =
      head === "git" && normalizedCommand !== head
        ? `${head} *`
        : normalizedCommand;
    return `bash(${pattern || canonicalToolName(input.name)})`;
  }

  if (input.type === "skill") {
    return `skill(${canonicalToolName(input.name)})`;
  }

  const explicitPattern = getStringParam(input.params, ["pattern"]);
  if (explicitPattern) {
    return `external_directory(${canonicalPath(explicitPattern)})`;
  }
  const externalPath = pathParam(input.params);
  if (externalPath) {
    const dir = directoryOf(externalPath) ?? externalPath;
    return `external_directory(${canonicalPath(dir)}/**)`;
  }
  return `external_directory(${canonicalToolName(input.name)})`;
}

export function isRememberablePermissionPattern(pattern: string): boolean {
  try {
    const parsed = parsePermissionPattern(pattern);
    return !(
      (parsed.tool === "edit" || parsed.tool === "write") &&
      !parsed.pattern
    );
  } catch {
    return false;
  }
}

export function inferPermissionType(
  toolName: string,
  params: Record<string, unknown>,
): PermissionPatternInput["type"] {
  if (toolName === "bash" || (isRecord(params) && "command" in params)) {
    return "bash";
  }
  if (toolName === "external_directory") {
    return "external_directory";
  }
  if (toolName === "skill") {
    return "skill";
  }
  return "tool";
}

export function findMatchingPermissionPattern(
  pattern: string,
  approved: ReadonlySet<string>,
): string | undefined {
  if (approved.has(pattern)) {
    return pattern;
  }
  for (const approvedPattern of approved) {
    if (wildcardToRegex(approvedPattern).test(pattern)) {
      return approvedPattern;
    }
  }
  return undefined;
}

export function matchPermissionPattern(
  pattern: string,
  approved: ReadonlySet<string>,
): boolean {
  return findMatchingPermissionPattern(pattern, approved) !== undefined;
}

export function matchesPermissionRule(
  call: PermissionCall,
  rule: PermissionRule,
): boolean {
  const toolName = effectiveToolName(call);
  const ruleTool = canonicalToolName(rule.tool);
  if (toolName !== ruleTool) {
    return false;
  }
  if (!rule.pattern || rule.pattern.trim() === "") {
    return true;
  }

  const pattern = rule.pattern.trim().toLowerCase();
  if (toolName === "bash") {
    const command = commandParam(call.params);
    return command ? matchesPattern(command, pattern) : false;
  }
  if (toolName === "skill") {
    const skillName = getStringParam(call.params, ["name"])?.toLowerCase();
    return skillName ? matchesPattern(skillName, pattern) : false;
  }

  const path = pathParam(call.params);
  return path ? globToRegex(pattern).test(canonicalPath(path)) : false;
}
