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
} as const;
