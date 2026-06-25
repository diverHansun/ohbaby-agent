export type UiCompactSessionStatus =
  | "not-needed"
  | "pruned"
  | "compacted"
  | "failed"
  | "inflated";

export interface UiCompactSessionOptions {
  readonly sessionId?: string;
  readonly force?: boolean;
}

export interface UiCompactSessionUsage {
  readonly currentTokens: number;
  readonly contextLimit: number;
  readonly inputBudgetTokens?: number;
  readonly modelId: string;
  readonly remainingTokens: number;
  readonly reservedOutputTokens?: number;
  readonly safetyMarginTokens?: number;
  readonly usageRatio: number;
}

export interface UiCompactSessionPruneResult {
  readonly prunedCount: number;
  readonly freedTokens: number;
  readonly protectedCount: number;
  readonly totalScanned: number;
}

export interface UiCompactSessionCompressionResult {
  readonly status: "compressed" | "skipped" | "failed" | "inflated";
  readonly originalTokens: number;
  readonly newTokens: number;
  readonly savedTokens: number;
  readonly summaryMessageId?: string;
  readonly error?: string;
}

export interface UiCompactSessionResult {
  readonly sessionId: string;
  readonly status: UiCompactSessionStatus;
  readonly usageBefore: UiCompactSessionUsage;
  readonly usageAfter: UiCompactSessionUsage;
  readonly prune?: UiCompactSessionPruneResult;
  readonly compression?: UiCompactSessionCompressionResult;
  readonly error?: string;
}
