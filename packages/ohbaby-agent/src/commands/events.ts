import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const commandOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  z.object({ kind: z.literal("markdown"), markdown: z.string() }).strict(),
  z
    .object({
      kind: z.literal("data"),
      subject: z.string(),
      data: z.record(z.unknown()),
    })
    .strict(),
]);

const commandActionSchema = z
  .object({
    kind: z.string(),
    label: z.string().optional(),
    data: z.record(z.unknown()).optional(),
  })
  .strict();

const commandErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean().optional(),
    details: z.unknown().optional(),
  })
  .strict();

const commandBaseSchema = z
  .object({
    commandRunId: z.string(),
    clientInvocationId: z.string(),
    timestamp: z.number(),
  })
  .strict();

export const CommandsEvent = {
  Started: BusEvent.define(
    "commands.started.internal",
    commandBaseSchema
      .extend({
        commandId: z.string(),
        path: z.array(z.string()),
        surface: z.string(),
        sessionId: z.string().optional(),
      })
      .strict(),
  ),
  ResultDelivered: BusEvent.define(
    "commands.result.delivered.internal",
    commandBaseSchema
      .extend({
        output: commandOutputSchema.optional(),
        action: commandActionSchema.optional(),
      })
      .strict(),
  ),
  Failed: BusEvent.define(
    "commands.failed.internal",
    commandBaseSchema.extend({ error: commandErrorSchema }).strict(),
  ),
  CatalogUpdated: BusEvent.define(
    "commands.catalog.updated.internal",
    z
      .object({
        version: z.string(),
        reason: z.string().optional(),
        timestamp: z.number(),
      })
      .strict(),
  ),
} as const;

