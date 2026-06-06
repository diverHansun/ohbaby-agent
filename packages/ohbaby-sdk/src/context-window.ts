export interface UiContextWindowUsage {
  readonly sessionId: string;
  readonly modelId: string;
  readonly currentTokens: number;
  readonly contextWindowTokens: number;
  readonly contextWindowRatio: number;
  readonly estimatedAt: string;
}
