import type { ChatCompletionCreateParams } from "openai/resources/chat/completions/completions";
import type { ChatCompletionMessage } from "../llm-client/index.js";
import type { TokenCounter } from "./types.js";

export function estimateWireHeuristic(
  messages: readonly ChatCompletionMessage[],
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
  tools?: ChatCompletionCreateParams["tools"],
): number {
  const payloads = messages.map((message) => JSON.stringify(message));
  if (tools !== undefined && tools.length > 0) {
    payloads.push(JSON.stringify(tools));
  }
  const text = payloads.join("\n");
  return Math.max(0, tokenCounter.estimateTokens(text));
}
