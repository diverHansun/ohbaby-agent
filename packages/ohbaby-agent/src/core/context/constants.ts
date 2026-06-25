export const COMPRESSION_THRESHOLD = 0.95;
export const COMPRESSION_PRESERVE_RATIO = 0.3;
export const KEEP_RECENT_TOKENS = 20_000;
export const COMPACTION_MIN_REMAINING_INPUT_TOKENS = 4_096;
export const MASK_EXEMPT_TOOL_PREFIXES = [
  "write",
  "edit",
  "task",
  "skill",
  "agent_",
] as const;
export const MASK_MIN_PART_TOKENS = 50;
export const MASK_MIN_PRUNABLE_TOKENS = 20_000;
export const MASK_MIN_USAGE_RATIO = 0.5;
export const MASK_PLACEHOLDER_PREFIX = "[Old tool result cleared";
export const MASK_PROTECTION_TOKENS = 40_000;
export const PRUNE_PROTECT_TOKENS = 40_000;
export const PRUNE_MINIMUM_TOKENS = 20_000;
export const SUMMARY_AGENT_NAME = "context";

export interface CompactionThresholds {
  readonly mask: number;
  readonly summary: number;
  readonly minRemainingInputTokens: number;
}

export const DEFAULT_COMPACTION_THRESHOLDS: CompactionThresholds = {
  mask: MASK_MIN_USAGE_RATIO,
  minRemainingInputTokens: COMPACTION_MIN_REMAINING_INPUT_TOKENS,
  summary: COMPRESSION_THRESHOLD,
};
