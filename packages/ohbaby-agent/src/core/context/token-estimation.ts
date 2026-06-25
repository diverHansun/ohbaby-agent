import type { ChatCompletionMessage } from "../llm-client/index.js";
import type { TokenCounter } from "./types.js";

export function estimateWireHeuristic(
  messages: readonly ChatCompletionMessage[],
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
): number {
  const text = messages.map((message) => JSON.stringify(message)).join("\n");
  return Math.max(0, tokenCounter.estimateTokens(text));
}
