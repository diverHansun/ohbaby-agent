import type { UiMessagePart, UiToolCall, UiToolResult } from "ohbaby-sdk";

export interface ToolLabelParts {
  readonly error: string;
  readonly name: string;
  readonly summary: string;
}

export function renderToolPart(part: UiMessagePart): string {
  switch (part.type) {
    case "tool-call":
      return renderToolLabel(part.call);
    case "tool-result":
      return part.result.error ? `Error ${formatBody(part.result.error)}` : "";
    case "text":
    case "reasoning":
      return part.text;
  }
}

export function renderToolLabel(
  call: UiToolCall,
  result?: UiToolResult,
): string {
  const parts = renderToolLabelParts(call, result);
  const summary = parts.summary === "" ? "" : ` ${parts.summary}`;
  const error = parts.error === "" ? "" : ` ${parts.error}`;
  return `${parts.name}${summary}${error}`;
}

export function renderToolLabelParts(
  call: UiToolCall,
  result?: UiToolResult,
): ToolLabelParts {
  const summary = formatPrimaryInput(call);
  const execution = result?.execution ?? call.execution;
  const error = result?.error
    ? `failed: ${formatBody(result.error)}`
    : call.status === "failed"
      ? "failed"
      : execution?.phase === "awaiting-approval"
        ? "awaiting approval"
        : "";
  return {
    error,
    name: formatToolName(call.name),
    summary,
  };
}

function formatToolName(name: string): string {
  return name
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatPrimaryInput(call: UiToolCall): string {
  if (call.name === "subagent_status") return "";
  const input = call.input;
  // Subagent prompts are runtime instructions, not user-facing task titles.
  const keys = call.name.startsWith("subagent_")
    ? ["name", "subagent_id"]
    : ["command", "file_path", "path", "query", "prompt"];
  for (const key of keys) {
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
