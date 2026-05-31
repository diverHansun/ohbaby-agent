import { parse as parseDotenv } from "dotenv";

function quoteValue(value: string): string {
  if (!/[\s#=]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function isAssignmentForKey(line: string, key: string): boolean {
  const trimmedStart = line.trimStart();
  if (trimmedStart.startsWith("#")) {
    return false;
  }

  const assignmentIndex = trimmedStart.indexOf("=");
  if (assignmentIndex === -1) {
    return false;
  }

  return trimmedStart.slice(0, assignmentIndex).trim() === key;
}

export function parseEnvFile(content: string): Record<string, string> {
  return parseDotenv(content);
}

export function setEnvFileValue(
  content: string,
  key: string,
  value: string,
): string {
  const rendered = `${key}=${quoteValue(value)}`;
  const normalizedContent = content.replace(/\r\n/gu, "\n");
  const lines =
    normalizedContent.length === 0
      ? []
      : normalizedContent.replace(/\n$/u, "").split("\n");
  let replaced = false;
  const nextLines: string[] = [];

  for (const line of lines) {
    if (!isAssignmentForKey(line, key)) {
      nextLines.push(line);
      continue;
    }

    if (!replaced) {
      nextLines.push(rendered);
      replaced = true;
    }
  }

  if (!replaced) {
    nextLines.push(rendered);
  }

  return `${nextLines.join("\n")}\n`;
}
