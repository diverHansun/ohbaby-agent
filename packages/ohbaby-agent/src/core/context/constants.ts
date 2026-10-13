export const COMPRESSION_THRESHOLD = 0.9;
export const KEEP_RECENT_TOKENS = 20_000;
export const SUMMARY_AGENT_NAME = "context";

export interface CompactionThresholds {
  readonly summary: number;
}

export const DEFAULT_COMPACTION_THRESHOLDS: CompactionThresholds = {
  summary: COMPRESSION_THRESHOLD,
};

export const SUMMARY_BODY_TOKENS = 16_384;
export const MAX_SUMMARY_PROVIDER_ATTEMPTS = 2;
