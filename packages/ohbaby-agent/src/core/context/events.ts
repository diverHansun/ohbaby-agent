import { z } from "zod";
import { BusEvent } from "../../bus/index.js";

const CompressionMetricsSchema = z.object({
  omittedParts: z.number().int().nonnegative().optional(),
  originalTokens: z.number(),
  newTokens: z.number(),
  savedTokens: z.number(),
});

const CompressionResultSchema = z.discriminatedUnion("status", [
  CompressionMetricsSchema.extend({
    status: z.literal("compressed"),
    summaryMessageId: z.string(),
  }),
  CompressionMetricsSchema.extend({
    status: z.literal("skipped"),
    reason: z.union([z.literal("stale"), z.literal("too-short")]),
  }),
  CompressionMetricsSchema.extend({
    status: z.literal("failed"),
    error: z.string(),
  }),
  CompressionMetricsSchema.extend({ status: z.literal("inflated") }),
]);

const ContextUsageSchema = z.object({
  currentTokens: z.number(),
  contextLimit: z.number(),
  inputBudgetTokens: z.number().optional(),
  reservedOutputTokens: z.number().optional(),
  safetyMarginTokens: z.number().optional(),
  usageRatio: z.number(),
  remainingTokens: z.number(),
  modelId: z.string(),
});

const ScopedContextIdentitySchema = z.object({
  contextScopeId: z.string().optional(),
  sessionId: z.string(),
});

const CompactionAttemptOutcomeSchema = z.union([
  z.literal("success"),
  z.literal("failed"),
  z.literal("inflated"),
  z.literal("skipped"),
  z.literal("aborted"),
]);

const CompactStatusSchema = z.union([
  z.literal("not-needed"),
  z.literal("compacted"),
  z.literal("failed"),
  z.literal("inflated"),
]);

export const ContextEvent = {
  CompactionStarted: BusEvent.define(
    "context.compaction.started",
    ScopedContextIdentitySchema.extend({
      attemptId: z.string(),
    }),
  ),
  CompactionFinished: BusEvent.define(
    "context.compaction.finished",
    ScopedContextIdentitySchema.extend({
      attemptId: z.string(),
      outcome: CompactionAttemptOutcomeSchema,
      rung: z.literal("summary").optional(),
      status: CompactStatusSchema,
      usageBefore: ContextUsageSchema.optional(),
      usageAfter: ContextUsageSchema.optional(),
      omittedParts: z.number().int().nonnegative().optional(),
    }),
  ),
  CompactionProgress: BusEvent.define(
    "context.compaction.progress",
    ScopedContextIdentitySchema.extend({
      attemptId: z.string(),
      attempt: z.number().int().positive(),
      // Model history projection estimate; excludes system/tools request overhead.
      estimatedHistoryTokens: z.number().nonnegative(),
    }),
  ),
  Compressed: BusEvent.define(
    "context.compressed",
    ScopedContextIdentitySchema.extend({
      attemptId: z.string(),
      result: CompressionResultSchema,
    }),
  ),
  TurnPrepared: BusEvent.define(
    "context.turn-prepared",
    ScopedContextIdentitySchema.extend({
      usage: ContextUsageSchema,
      tookMs: z.number(),
      triggeredCompaction: z.boolean(),
    }),
  ),
  CompactSkipped: BusEvent.define(
    "context.compact-skipped",
    ScopedContextIdentitySchema.extend({
      attemptId: z.string(),
      reason: z.union([
        z.literal("not-needed"),
        z.literal("too-short"),
        z.literal("inflated"),
        z.literal("stale"),
      ]),
      usage: ContextUsageSchema,
    }),
  ),
} as const;
