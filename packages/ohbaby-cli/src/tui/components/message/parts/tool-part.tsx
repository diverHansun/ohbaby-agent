import type { UiMessagePart } from "ohbaby-sdk";

export function renderToolPart(part: UiMessagePart): string {
  switch (part.type) {
    case "tool-call": {
      const input = formatInput(part.call.input);

      return formatBlock(
        `tool ${part.call.name} (${part.call.status})`,
        input === "" ? null : `input: ${input}`,
      );
    }
    case "tool-result":
      return formatBlock(
        `tool result ${part.result.callId} (${
          part.result.error ? "failed" : "completed"
        })`,
        part.result.error
          ? `error: ${formatBody(part.result.error)}`
          : formatOutput(part.result.output),
      );
    case "text":
    case "reasoning":
      return part.text;
  }
}

function formatBlock(title: string, detail: string | null): string {
  if (detail === null || detail.trim() === "") {
    return title;
  }

  return `${title}\n  ${detail.replace(/\r?\n/gu, "\n  ")}`;
}

function formatInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);

  if (keys.length === 0) {
    return "";
  }

  return truncate(JSON.stringify(input));
}

function formatOutput(output: string): string {
  return output.trim() === "" ? "result hidden" : "result hidden";
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
