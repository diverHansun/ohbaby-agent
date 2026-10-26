import type { LLMClientInstance, ModelOrigin } from "ohbaby-llm";
import type { ContextLLMClient, TokenCounter } from "./context/types.js";

/** Immutable model dependencies captured for one execution. */
export interface ContextModel {
  readonly entryId: string;
  readonly tokenCounter: TokenCounter;
  readonly summaryClient: ContextLLMClient;
}

export interface RunModel extends ContextModel {
  readonly client: LLMClientInstance;
  readonly modelOrigin: ModelOrigin;
}
