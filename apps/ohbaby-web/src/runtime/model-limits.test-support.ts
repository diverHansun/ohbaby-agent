import type { UiModelSettingsNumericView } from "ohbaby-sdk";

/**
 * Fixture numbers for a model with no overrides and nothing detected. The
 * page never computes these; they stand in for what the server reports.
 */
export const AUTO_LIMITS: UiModelSettingsNumericView = {
  effectiveContextWindowTokens: 300_000,
  effectiveMaxOutputTokens: 32_768,
  contextDiscovery: { status: "unknown" },
};
