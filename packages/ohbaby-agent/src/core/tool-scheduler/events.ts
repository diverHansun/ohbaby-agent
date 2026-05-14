import { z } from "zod";
import { BusEvent } from "../../bus/index.js";

const ToolCallStatusSchema = z.union([
  z.literal("pending"),
  z.literal("checking_policy"),
  z.literal("awaiting_approval"),
  z.literal("queued"),
  z.literal("executing"),
  z.literal("success"),
  z.literal("error"),
  z.literal("rejected"),
  z.literal("cancelled"),
]);

const ToolCallErrorSchema = z.object({
  type: z.union([
    z.literal("ToolNotFoundError"),
    z.literal("PolicyDeniedError"),
    z.literal("PermissionRejectedError"),
    z.literal("ExecutionError"),
    z.literal("TimeoutError"),
    z.literal("CancelledError"),
    z.literal("ValidationError"),
  ]),
  message: z.string(),
  details: z.unknown().optional(),
});

const ToolCallResultSchema = z.object({
  callId: z.string(),
  status: z.union([
    z.literal("success"),
    z.literal("error"),
    z.literal("rejected"),
    z.literal("cancelled"),
  ]),
  output: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  error: ToolCallErrorSchema.optional(),
  duration: z.number().optional(),
});

export const ToolSchedulerEvent = {
  StatusChanged: BusEvent.define(
    "tool-scheduler.status-changed",
    z.object({
      callId: z.string(),
      toolName: z.string(),
      previousStatus: ToolCallStatusSchema,
      currentStatus: ToolCallStatusSchema,
      timestamp: z.number(),
    }),
  ),
  ExecutionStarted: BusEvent.define(
    "tool-scheduler.execution-started",
    z.object({
      callId: z.string(),
      toolName: z.string(),
      params: z.record(z.unknown()),
      timestamp: z.number(),
    }),
  ),
  ExecutionCompleted: BusEvent.define(
    "tool-scheduler.execution-completed",
    z.object({
      callId: z.string(),
      toolName: z.string(),
      result: ToolCallResultSchema,
      timestamp: z.number(),
    }),
  ),
} as const;
