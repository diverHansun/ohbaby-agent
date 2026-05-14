import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const PermissionTypeSchema = z.union([
  z.literal("tool"),
  z.literal("bash"),
  z.literal("skill"),
  z.literal("external_directory"),
]);

const PermissionInfoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  messageId: z.string(),
  callId: z.string().optional(),
  type: PermissionTypeSchema,
  name: z.string(),
  title: z.string(),
  metadata: z.record(z.unknown()),
  pattern: z.string(),
  time: z.object({
    created: z.number(),
  }),
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
      callId: z.string().optional(),
      response: PermissionResponseSchema,
    }),
  ),
  SwitchModeRequested: BusEvent.define(
    "permission.switch-mode-requested",
    z.object({
      sessionId: z.string(),
      targetMode: z.literal("edit-automatically"),
      trigger: z.object({
        permissionId: z.string(),
        pattern: z.string(),
      }),
    }),
  ),
} as const;
