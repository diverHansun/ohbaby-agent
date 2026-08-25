import type { PreparedModelRequest, TokenCounter } from "./types.js";

export function estimatePreparedRequestHeuristic(
  request: PreparedModelRequest,
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
): number {
  const payloads = request.messages.map((message) => JSON.stringify(message));
  if (request.tools !== undefined && request.tools.length > 0) {
    payloads.push(JSON.stringify(request.tools));
  }
  const text = payloads.join("\n");
  return Math.max(0, tokenCounter.estimateTokens(text));
}
