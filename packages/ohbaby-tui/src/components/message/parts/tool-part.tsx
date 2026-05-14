import type { UiMessagePart } from "ohbaby-sdk";

export function renderToolPart(part: UiMessagePart): string {
  switch (part.type) {
    case "tool-call":
      return `[tool:${part.call.name} ${part.call.status}]`;
    case "tool-result":
      return part.result.error ?? part.result.output;
    case "text":
    case "reasoning":
      return part.text;
  }
}
