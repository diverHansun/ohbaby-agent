import { z } from "zod";
import { BusEvent } from "../../bus/index.js";

const MemoryScopeSchema = z.union([z.literal("global"), z.literal("project")]);
const MergedMemorySchema = z.object({
  global: z.string(),
  project: z.string(),
  merged: z.string(),
});

export const MemoryEvent = {
  Added: BusEvent.define(
    "memory.added",
    z.object({
      scope: MemoryScopeSchema,
      text: z.string(),
    }),
  ),
  Updated: BusEvent.define(
    "memory.updated",
    z.object({
      scope: MemoryScopeSchema,
      index: z.number(),
      newText: z.string(),
    }),
  ),
  Removed: BusEvent.define(
    "memory.removed",
    z.object({
      scope: MemoryScopeSchema,
      index: z.number(),
    }),
  ),
  Refreshed: BusEvent.define(
    "memory.refreshed",
    z.object({
      directory: z.string(),
      memory: MergedMemorySchema,
    }),
  ),
} as const;
