import { z } from "zod";
import { BusEvent } from "../../bus/index.js";
import type { Session } from "./types.js";

const SessionStatsSchema = z.object({
  messageCount: z.number().int().nonnegative(),
  lastMessageAt: z.number().optional(),
});

const SessionSchema: z.ZodType<Session> = z.object({
  id: z.string(),
  projectId: z.string(),
  projectRoot: z.string(),
  title: z.string(),
  agentName: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: z.union([z.literal("active"), z.literal("archived")]),
  stats: SessionStatsSchema,
  parentId: z.string().optional(),
  childrenIds: z.array(z.string()),
  isSubagent: z.boolean(),
});

export const SessionEvent = {
  Created: BusEvent.define(
    "session.created",
    z.object({
      session: SessionSchema,
    }),
  ),
  Updated: BusEvent.define(
    "session.updated",
    z.object({
      session: SessionSchema,
    }),
  ),
  Removed: BusEvent.define(
    "session.removed",
    z.object({
      sessionId: z.string(),
    }),
  ),
} as const;
