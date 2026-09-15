import type { ModelState } from "../../services/interface-providers/native-state.js";
import type { MessageWithParts } from "../message/index.js";
import { isActivePart } from "./filters.js";
import type { TokenCounter } from "./types.js";

/** A native assistant and all its tool results form one indivisible history unit. */
export function hasNativeDependencies(message: MessageWithParts): boolean {
  return message.parts.some(
    (part) => part.type === "model-state" && isActivePart(part),
  );
}
export function hasUnfinishedNativeDependencies(
  message: MessageWithParts,
): boolean {
  return (
    hasNativeDependencies(message) &&
    (message.info.time.completed === undefined ||
      message.parts.some(
        (part) =>
          part.type === "tool" &&
          isActivePart(part) &&
          (part.state.status === "pending" || part.state.status === "running"),
      ))
  );
}

/** Opaque blocks share one response allowance; a signature is never opaque thinking. */
export function estimateNativeStateTokens(
  state: ModelState,
  counter: Pick<TokenCounter, "estimateTokens">,
): number {
  const readable: string[] = [];
  let opaque = false;
  switch (state.output.protocol) {
    case "openai-responses":
      for (const item of state.output.items) {
        if (item.type !== "reasoning") continue;
        readable.push(
          ...item.summary.map((part) => part.text),
          ...(item.content ?? []).map((part) => part.text),
        );
        opaque ||=
          typeof item.encrypted_content === "string" &&
          item.encrypted_content.length > 0;
      }
      break;
    case "anthropic":
      for (const item of state.output.items) {
        if (item.type === "thinking") readable.push(item.thinking);
        if (item.type === "redacted_thinking") opaque = true;
      }
      break;
    case "openai-compatible": {
      const details = state.output.reasoningDetails ?? [];
      const detailText = details.flatMap((part) =>
        part.type === "reasoning.text"
          ? [part.text ?? ""]
          : part.type === "reasoning.summary"
            ? [part.summary]
            : [],
      );
      // A provider may send the same text both as a convenience field and native details.
      readable.push(...detailText);
      const text = state.output.reasoningText ?? "";
      if (
        text !== "" &&
        !detailText.includes(text) &&
        details
          .filter((part) => part.type === "reasoning.text")
          .map((part) => part.text ?? "")
          .join("") !== text
      )
        readable.push(text);
      opaque = details.some((part) => part.type === "reasoning.encrypted");
      break;
    }
  }
  const text = readable.filter(Boolean).join("\n");
  return (
    (text === "" ? 0 : Math.max(0, counter.estimateTokens(text))) +
    (opaque ? state.estimate.tokens : 0)
  );
}
