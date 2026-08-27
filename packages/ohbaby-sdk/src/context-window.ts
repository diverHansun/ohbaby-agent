export interface UiContextOccupancyComposition {
  readonly "system-prompt": number;
  readonly "builtin-tools": number;
  readonly mcp: number;
  readonly skills: number;
  readonly conversation: number;
  readonly "summarized-conversation": number;
  readonly "subagent-exchanges": number;
}

export interface UiContextWindowUsage {
  readonly sessionId: string;
  readonly modelId: string;
  readonly currentTokens: number;
  readonly contextWindowTokens: number;
  readonly contextWindowRatio: number;
  readonly composition?: UiContextOccupancyComposition;
  readonly estimatedAt: string;
}
