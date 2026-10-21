export interface UiPromptCacheUsage {
  readonly sessionId: string;
  readonly accountedInputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheReadShare: number | null;
}
