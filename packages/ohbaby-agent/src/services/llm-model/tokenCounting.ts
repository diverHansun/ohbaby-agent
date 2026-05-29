import {
  createModelProfileRegistry,
  type ModelProfileRegistration,
  type TokenBudget,
  type TokenBudgetOptions,
} from "./modelProfiles.js";

const ASCII_TOKEN_WEIGHT = 0.25;
const NON_ASCII_TOKEN_WEIGHT = 1.3;
const DEFAULT_MODEL_LIMIT = 128_000;

export interface HeuristicTokenCounterOptions {
  readonly defaultLimit?: number;
  readonly defaultMaxOutputTokens?: number;
  readonly profiles?: readonly ModelProfileRegistration[];
  readonly provider?: string;
}

export interface HeuristicTokenCounter {
  estimateTokens(content: string): number;
  getBudget(modelId: string, options?: TokenBudgetOptions): TokenBudget;
  getLimit(modelId: string): number;
}

export function estimateTokensForText(text: string): number {
  assertString(text, "text");

  if (text.length === 0) {
    return 0;
  }

  const weightedTokens = Array.from(text).reduce((sum, codePoint) => {
    const codePointValue = codePoint.codePointAt(0);

    if (codePointValue !== undefined && codePointValue <= 0x7f) {
      return sum + ASCII_TOKEN_WEIGHT;
    }

    return sum + NON_ASCII_TOKEN_WEIGHT;
  }, 0);

  return Math.ceil(weightedTokens);
}

export function createHeuristicTokenCounter(
  options: HeuristicTokenCounterOptions = {},
): HeuristicTokenCounter {
  const defaultLimit =
    options.defaultLimit === undefined
      ? DEFAULT_MODEL_LIMIT
      : normalizeContextLimit(options.defaultLimit);
  const registry = createModelProfileRegistry({
    defaultProvider: options.provider,
    fallbackContextWindowTokens: defaultLimit,
    fallbackMaxOutputTokens: options.defaultMaxOutputTokens,
    userProfiles: options.profiles,
  });
  return {
    estimateTokens: estimateTokensForText,
    getBudget(modelId: string, budgetOptions?: TokenBudgetOptions): TokenBudget {
      return registry.calculateBudget(modelId, budgetOptions);
    },
    getLimit(modelId: string): number {
      return registry.resolve(modelId).contextWindowTokens;
    },
  };
}

function normalizeContextLimit(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return DEFAULT_MODEL_LIMIT;
  }

  return Math.ceil(tokens);
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
}
