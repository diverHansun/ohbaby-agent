import { activeModelBudgetProfiles, type LLMClientInstance } from "ohbaby-llm";
import type { RunModel } from "../../core/run-model.js";
import { createHeuristicTokenCounter } from "../../services/llm-model/index.js";
import { createContextSummaryClient } from "./prompt-context.js";

const models = new WeakMap<LLMClientInstance, Map<string, RunModel>>();

export function createRunModel(
  entryId: string,
  client: LLMClientInstance,
): RunModel {
  let entries = models.get(client);
  if (!entries) {
    entries = new Map();
    models.set(client, entries);
  }
  const existing = entries.get(entryId);
  if (existing) return existing;
  const runModel: RunModel = Object.freeze({
    entryId,
    client,
    tokenCounter: createHeuristicTokenCounter({
      defaultLimit: client.config.contextWindowTokens,
      defaultMaxOutputTokens: client.config.maxTokens,
      profiles: activeModelBudgetProfiles(client.config),
      provider: client.config.provider,
    }),
    summaryClient: createContextSummaryClient(client),
    modelOrigin: Object.freeze({
      provider: client.config.provider,
      model: client.config.model,
      protocol: client.config.interfaceProvider,
      endpoint: client.config.baseUrl,
    }),
  });
  entries.set(entryId, runModel);
  return runModel;
}
