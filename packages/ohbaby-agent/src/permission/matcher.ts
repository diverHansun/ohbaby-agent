import type { PermissionPatternInput } from "./types.js";

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

function encodePatternSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
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

export function generatePermissionPattern(
  input: PermissionPatternInput,
): string {
  if (input.type === "tool") {
    if (input.name === "edit" || input.name === "write") {
      const filePath = getStringParam(input.params, [
        "file_path",
        "filePath",
        "path",
      ]);
      const dir = filePath ? directoryOf(filePath) : undefined;
      if (dir) {
        return `tool:${input.name}:${dir}/**`;
      }
    }
    return `tool:${input.name}`;
  }

  if (input.type === "bash") {
    const command = getStringParam(input.params, ["command"]) ?? input.name;
    const normalizedCommand = normalizeCommand(command);
    const [head] = commandParts(normalizedCommand);
    return `bash:${head ?? input.name}:${encodePatternSegment(normalizedCommand)}`;
  }

  if (input.type === "skill") {
    return `skill:${input.name}`;
  }

  return `${input.type}:${input.name}`;
}

export function isRememberablePermissionPattern(pattern: string): boolean {
  return pattern !== "tool:edit" && pattern !== "tool:write";
}

export function inferPermissionType(
  toolName: string,
  params: Record<string, unknown>,
): PermissionPatternInput["type"] {
  if (toolName === "bash" || (isRecord(params) && "command" in params)) {
    return "bash";
  }
  if (toolName === "skill") {
    return "skill";
  }
  return "tool";
}

export function matchPermissionPattern(
  pattern: string,
  approved: ReadonlySet<string>,
): boolean {
  if (approved.has(pattern)) {
    return true;
  }
  for (const approvedPattern of approved) {
    if (wildcardToRegex(approvedPattern).test(pattern)) {
      return true;
    }
  }
  return false;
}
