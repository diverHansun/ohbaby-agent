import { z } from "zod";
import { BusEvent } from "../../bus/index.js";

const CompressionResultSchema = z.object({
  status: z.union([
    z.literal("compressed"),
    z.literal("skipped"),
    z.literal("failed"),
    z.literal("inflated"),
  ]),
  originalTokens: z.number(),
  newTokens: z.number(),
  savedTokens: z.number(),
  reason: z.union([z.literal("stale"), z.literal("too-short")]).optional(),
  summaryMessageId: z.string().optional(),
  error: z.string().optional(),
});

const PruneResultSchema = z.object({
  prunedCount: z.number(),
  freedTokens: z.number(),
  protectedCount: z.number(),
  totalScanned: z.number(),
});

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

const MaskSkippedReasonSchema = z.union([
  z.literal("below-threshold"),
  z.literal("below-batch"),
  z.literal("all-exempt"),
]);

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
  z.literal("pruned"),
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
      rung: z.union([z.literal("prune"), z.literal("summary")]).optional(),
      status: CompactStatusSchema,
    }),
  ),
  Compressed: BusEvent.define(
    "context.compressed",
    ScopedContextIdentitySchema.extend({
      attemptId: z.string(),
      result: CompressionResultSchema,
    }),
  ),
  Pruned: BusEvent.define(
    "context.pruned",
    ScopedContextIdentitySchema.extend({
      attemptId: z.string(),
      result: PruneResultSchema,
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
        z.literal("thrash-locked"),
        z.literal("per-turn-cap"),
        z.literal("stale"),
      ]),
      usage: ContextUsageSchema,
    }),
  ),
  Masked: BusEvent.define(
    "context.masked",
    ScopedContextIdentitySchema.extend({
      enabled: z.boolean(),
      maskedPartIds: z.array(z.string()),
      maskedTokens: z.number(),
      cutoff: z.number(),
      usageRatio: z.number(),
      skippedReason: MaskSkippedReasonSchema.optional(),
    }),
  ),
} as const;
