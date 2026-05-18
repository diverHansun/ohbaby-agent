import type { UiMessagePart } from "ohbaby-sdk";

export function renderToolPart(part: UiMessagePart): string {
  switch (part.type) {
    case "tool-call":
      return `tool ${part.call.name} (${part.call.status}) ${formatInput(
        part.call.input,
      )}`.trimEnd();
    case "tool-result":
      return part.result.error
        ? `tool result ${part.result.callId}: ${part.result.error}`
        : `tool result ${part.result.callId}: ${formatOutput(
            part.result.output,
          )}`;
    case "text":
    case "reasoning":
      return part.text;
  }
}

function formatInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);

  if (keys.length === 0) {
    return "";
  }

  return truncate(JSON.stringify(input));
}

function formatOutput(output: string): string {
  return truncate(output.trim());
}

function truncate(value: string): string {
  const limit = 180;

  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 3)}...`;
}
