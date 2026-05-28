import { z } from "zod";
import { BusEvent } from "../../bus/index.js";
import type { Message, Part } from "./types.js";

const MessageTimeSchema = z.object({
  created: z.number(),
  updated: z.number().optional(),
  completed: z.number().optional(),
});

const MessageErrorSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("ProviderAuthError"),
    providerId: z.string(),
    message: z.string(),
  }),
  z.object({ name: z.literal("MessageOutputLengthError") }),
  z.object({
    name: z.literal("MessageAbortedError"),
    message: z.string(),
  }),
  z.object({
    name: z.literal("APIError"),
    message: z.string(),
    statusCode: z.number().optional(),
    isRetryable: z.boolean(),
  }),
  z.object({
    name: z.literal("Unknown"),
    message: z.string(),
  }),
]);

const MessageSchema: z.ZodType<Message> = z.discriminatedUnion("role", [
  z.object({
    id: z.string(),
    sessionId: z.string(),
    role: z.literal("user"),
    time: MessageTimeSchema,
    agent: z.string(),
    model: z
      .object({
        providerId: z.string(),
        modelId: z.string(),
      })
      .optional(),
    system: z.string().optional(),
    tools: z.record(z.boolean()).optional(),
  }),
  z.object({
    id: z.string(),
    sessionId: z.string(),
    role: z.literal("assistant"),
    time: MessageTimeSchema,
    agent: z.string(),
    parentId: z.string().optional(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
    finish: z.string().optional(),
    error: MessageErrorSchema.optional(),
  }),
  z.object({
    id: z.string(),
    sessionId: z.string(),
    role: z.literal("system"),
    time: MessageTimeSchema,
    kind: z.union([z.literal("abort"), z.literal("error"), z.literal("info")]),
    agent: z.string().optional(),
  }),
]);

const PartBaseSchema = {
  id: z.string(),
  messageId: z.string(),
  sessionId: z.string(),
  orderIndex: z.number(),
  time: z
    .object({
      compacted: z.number().optional(),
    })
    .optional(),
} as const;

const ToolStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    input: z.record(z.unknown()),
    raw: z.string(),
  }),
  z.object({
    status: z.literal("running"),
    input: z.record(z.unknown()),
    title: z.string().optional(),
  }),
  z.object({
    status: z.literal("completed"),
    input: z.record(z.unknown()),
    output: z.string(),
    metadata: z.record(z.unknown()).optional(),
  }),
  z.object({
    status: z.literal("error"),
    input: z.record(z.unknown()),
    error: z.string(),
    metadata: z.record(z.unknown()).optional(),
  }),
  z.object({
    status: z.literal("aborted"),
    input: z.record(z.unknown()),
    error: z.literal("Tool execution aborted by user"),
    metadata: z.record(z.unknown()).optional(),
  }),
]);

const PartSchema: z.ZodType<Part> = z.discriminatedUnion("type", [
  z.object({
    ...PartBaseSchema,
    type: z.literal("text"),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
  }),
  z.object({
    ...PartBaseSchema,
    type: z.literal("reasoning"),
    text: z.string(),
    metadata: z.record(z.unknown()).optional(),
  }),
  z.object({
    ...PartBaseSchema,
    type: z.literal("tool"),
    callId: z.string(),
    tool: z.string(),
    state: ToolStateSchema,
    metadata: z.record(z.unknown()).optional(),
  }),
]);

export const MessageEvent = {
  Updated: BusEvent.define(
    "message.updated",
    z.object({
      info: MessageSchema,
    }),
  ),
  Removed: BusEvent.define(
    "message.removed",
    z.object({
      sessionId: z.string(),
      messageId: z.string(),
    }),
  ),
  PartUpdated: BusEvent.define(
    "message.part-updated",
    z.object({
      part: PartSchema,
      delta: z.string().optional(),
    }),
  ),
  PartRemoved: BusEvent.define(
    "message.part-removed",
    z.object({
      sessionId: z.string(),
      messageId: z.string(),
      partId: z.string(),
    }),
  ),
} as const;
