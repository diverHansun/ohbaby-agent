import type { UiMessagePart } from "ohbaby-sdk";

export function renderToolPart(part: UiMessagePart): string {
  switch (part.type) {
    case "tool-call": {
      const leading = part.call.status === "running" ? "⠋ " : "  ";
      const summary = formatPrimaryInput(part.call.input);
      return `${leading}${formatToolName(part.call.name)}${
        summary === "" ? "" : ` ${summary}`
      }`;
    }
    case "tool-result":
      return part.result.error ? `  Error ${formatBody(part.result.error)}` : "";
    case "text":
    case "reasoning":
      return part.text;
  }
}

function formatToolName(name: string): string {
  return name
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatPrimaryInput(input: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "path", "query", "prompt"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") {
      return truncate(value.trim());
    }
  }

  return "";
}

function formatBody(output: string): string {
  return truncate(output.trim());
}

function truncate(value: string): string {
  const limit = 180;

  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 3)}...`;
}
