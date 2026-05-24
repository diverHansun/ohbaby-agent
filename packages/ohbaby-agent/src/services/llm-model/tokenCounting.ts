import {
  createModelProfileRegistry,
  type ModelProfileRegistration,
  type TokenBudget,
  type TokenBudgetOptions,
} from "./modelProfiles.js";

const ASCII_TOKEN_WEIGHT = 0.25;
const NON_ASCII_TOKEN_WEIGHT = 1.3;
const CONVERSATION_OVERHEAD_TOKENS = 4;
const EMPTY_MODEL_LIMIT = 4_096;
const DEFAULT_MODEL_LIMIT = 128_000;
const DEFAULT_MAX_RESPONSE_TOKENS = 2_048;

export interface HeuristicTokenCounterOptions {
  readonly defaultLimit?: number;
  readonly defaultMaxOutputTokens?: number;
  readonly profiles?: readonly ModelProfileRegistration[];
  readonly provider?: string;
}

export type TokenCountMessage =
  | {
      readonly role: "system";
      readonly content: string;
    }
  | {
      readonly role: "user";
      readonly content: string;
    }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?: readonly unknown[];
    }
  | {
      readonly role: "tool";
      readonly content: string;
      readonly tool_call_id: string;
    };

export interface ContextTokens {
  readonly messagesTokens: number;
  readonly estimatedResponseTokens: number;
  readonly totalUsedTokens: number;
  readonly remainingTokens: number;
  readonly usage: {
    readonly hasWarning: boolean;
    readonly percentUsed: number;
  };
}

export type TokenWarningSeverity = "none" | "warning" | "critical";

export interface TokenWarning {
  readonly isApproaching: boolean;
  readonly severity: TokenWarningSeverity;
  readonly percentUsed: number;
  readonly tokensRemaining: number;
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

export function estimateTokensForMessage(message: TokenCountMessage): number {
  switch (message.role) {
    case "system":
      return estimateTokensForText(message.content) + 100;
    case "user":
      return estimateTokensForText(message.content) + 3;
    case "assistant":
      return (
        estimateOptionalContentTokens(message.content) +
        estimateToolCallsTokens(message.tool_calls) +
        3
      );
    case "tool":
      return (
        estimateTokensForText(message.content) +
        estimateTokensForText(message.tool_call_id) +
        5
      );
  }
}

export function estimateTokensForMessages(
  messages: readonly TokenCountMessage[],
): number {
  assertArray(messages, "messages");

  return (
    messages.reduce(
      (sum, message) => sum + estimateTokensForMessage(message),
      0,
    ) + CONVERSATION_OVERHEAD_TOKENS
  );
}

export function getTokenLimit(
  model: string,
  defaultLimit = DEFAULT_MODEL_LIMIT,
): number {
  assertString(model, "model");

  const normalized = model.trim().toLowerCase();

  if (normalized === "") {
    return EMPTY_MODEL_LIMIT;
  }

  if (
    normalized.includes("realtime") ||
    normalized.includes("transcribe") ||
    normalized.includes("audio")
  ) {
    return EMPTY_MODEL_LIMIT;
  }

  return createModelProfileRegistry({
    fallbackContextWindowTokens: normalizeContextLimit(defaultLimit),
  }).resolve(model).contextWindowTokens;
}

export function calculateContextTokens(
  messages: readonly TokenCountMessage[],
  model: string,
  maxResponseTokens = DEFAULT_MAX_RESPONSE_TOKENS,
): ContextTokens {
  const messagesTokens = estimateTokensForMessages(messages);
  const estimatedResponseTokens = normalizeTokenBudget(maxResponseTokens);
  const totalUsedTokens = messagesTokens + estimatedResponseTokens;
  const tokenLimit = getTokenLimit(model);
  const remainingTokens = tokenLimit - totalUsedTokens;
  const percentUsed =
    tokenLimit === 0 ? 100 : (totalUsedTokens / tokenLimit) * 100;

  return {
    estimatedResponseTokens,
    messagesTokens,
    remainingTokens,
    totalUsedTokens,
    usage: {
      hasWarning: percentUsed >= 80,
      percentUsed,
    },
  };
}

export function isApproachingTokenLimit(
  messages: readonly TokenCountMessage[],
  model: string,
): TokenWarning {
  const context = calculateContextTokens(messages, model);
  const tokenLimit = getTokenLimit(model);
  const percentUsed = context.usage.percentUsed;
  const severity = getWarningSeverity(percentUsed);

  return {
    isApproaching: severity !== "none",
    percentUsed,
    severity,
    tokensRemaining: tokenLimit - context.totalUsedTokens,
  };
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

function estimateOptionalContentTokens(content: string | null): number {
  if (content === null) {
    return 0;
  }

  return estimateTokensForText(content);
}

function estimateToolCallsTokens(
  toolCalls: readonly unknown[] | undefined,
): number {
  if (toolCalls === undefined) {
    return 0;
  }

  return estimateTokensForText(JSON.stringify(toolCalls));
}

function getWarningSeverity(percentUsed: number): TokenWarningSeverity {
  if (percentUsed >= 95) {
    return "critical";
  }

  if (percentUsed >= 80) {
    return "warning";
  }

  return "none";
}

function normalizeTokenBudget(tokens: number): number {
  if (!Number.isFinite(tokens)) {
    return DEFAULT_MAX_RESPONSE_TOKENS;
  }

  return Math.max(0, Math.ceil(tokens));
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

function assertArray(
  value: unknown,
  name: string,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
}
