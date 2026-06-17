export type UiSearchProvider = "tavily";

export interface UiSetSearchApiKeyInput {
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly provider?: UiSearchProvider;
}

export interface UiSetSearchApiKeyResult {
  readonly apiKeyEnv: string;
  readonly provider: UiSearchProvider;
  readonly envPath: string;
  readonly searchJsonPath: string;
}
