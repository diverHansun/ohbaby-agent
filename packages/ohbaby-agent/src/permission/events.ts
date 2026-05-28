import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const PermissionTypeSchema = z.union([
  z.literal("tool"),
  z.literal("bash"),
  z.literal("skill"),
  z.literal("external_directory"),
  z.literal("sensitive_path"),
]);

const PermissionInfoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
  callId: z.string(),
  type: PermissionTypeSchema,
  name: z.string(),
  title: z.string(),
  metadata: z.record(z.unknown()),
  pattern: z.string(),
  time: z.object({
    created: z.number(),
  }),
});

const PermissionRuleSchema = z.object({
  tool: z.string(),
  pattern: z.string().optional(),
  decision: z.union([z.literal("allow"), z.literal("deny")]),
  scope: z.literal("session"),
  reason: z.string().optional(),
});

const PermissionResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once") }),
  z.object({ type: z.literal("always"), pattern: z.string().optional() }),
  z.object({ type: z.literal("reject") }),
  z.object({ type: z.literal("suggest"), suggestion: z.string() }),
  z.object({ type: z.literal("cancel") }),
  z.object({ type: z.literal("auto_approved"), pattern: z.string() }),
]);

export const PermissionEvent = {
  ModeChanged: BusEvent.define(
    "permission.mode.changed",
    z.object({
      previous: z.union([z.literal("plan"), z.literal("auto")]),
      current: z.union([z.literal("plan"), z.literal("auto")]),
    }),
  ),
  LevelChanged: BusEvent.define(
    "permission.level.changed",
    z.object({
      previous: z.union([z.literal("default"), z.literal("full-access")]),
      current: z.union([z.literal("default"), z.literal("full-access")]),
    }),
  ),
  RuleAdded: BusEvent.define(
    "permission.rule.added",
    z.object({
      sessionId: z.string(),
      rule: PermissionRuleSchema,
    }),
  ),
  Updated: BusEvent.define(
    "permission.updated",
    z.object({
      info: PermissionInfoSchema,
    }),
  ),
  Replied: BusEvent.define(
    "permission.replied",
    z.object({
      sessionId: z.string(),
      permissionId: z.string(),
      callId: z.string(),
      response: PermissionResponseSchema,
    }),
  ),
} as const;
