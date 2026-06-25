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

export const ContextEvent = {
  Compressed: BusEvent.define(
    "context.compressed",
    z.object({
      sessionId: z.string(),
      result: CompressionResultSchema,
    }),
  ),
  Pruned: BusEvent.define(
    "context.pruned",
    z.object({
      sessionId: z.string(),
      result: PruneResultSchema,
    }),
  ),
  TurnPrepared: BusEvent.define(
    "context.turn-prepared",
    z.object({
      sessionId: z.string(),
      usage: ContextUsageSchema,
      tookMs: z.number(),
      triggeredCompaction: z.boolean(),
    }),
  ),
  CompactSkipped: BusEvent.define(
    "context.compact-skipped",
    z.object({
      sessionId: z.string(),
      reason: z.union([
        z.literal("not-needed"),
        z.literal("too-short"),
        z.literal("inflated"),
        z.literal("thrash-locked"),
      ]),
      usage: ContextUsageSchema,
    }),
  ),
  Masked: BusEvent.define(
    "context.masked",
    z.object({
      sessionId: z.string(),
      enabled: z.boolean(),
      maskedPartIds: z.array(z.string()),
      maskedTokens: z.number(),
      cutoff: z.number(),
      usageRatio: z.number(),
      skippedReason: MaskSkippedReasonSchema.optional(),
    }),
  ),
} as const;
