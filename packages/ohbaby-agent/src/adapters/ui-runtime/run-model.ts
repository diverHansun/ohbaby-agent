import { activeModelBudgetProfiles, type LLMClientInstance } from "ohbaby-llm";
import type { UiPromptError } from "ohbaby-sdk";
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
  const tokenCounter = createHeuristicTokenCounter({
    defaultLimit: client.config.contextWindowTokens,
    defaultMaxOutputTokens: client.config.maxTokens,
    profiles: activeModelBudgetProfiles(client.config),
    provider: client.config.provider,
  });
  const budget = tokenCounter.getBudget(client.config.model);
  if (budget.inputBudgetTokens <= 0) {
    const promptError: UiPromptError = {
      code: "MODEL_TOKEN_LIMITS_INCOMPATIBLE",
      message:
        "Model context window cannot fit the max output and safety reserve; reduce max output or correct the context window in model settings.",
      source: "runtime",
      retryable: false,
    };
    throw Object.assign(new Error(promptError.message), {
      code: promptError.code,
      promptError,
    });
  }
  const runModel: RunModel = Object.freeze({
    entryId,
    client,
    tokenCounter,
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
