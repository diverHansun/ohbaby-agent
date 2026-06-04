import { z } from "zod";
import { BusEvent } from "../../bus/index.js";

const interactionOptionSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
    disabled: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const interactionRequestSchema = z
  .object({
    interactionId: z.string(),
    commandRunId: z.string(),
    clientInvocationId: z.string().optional(),
    sessionId: z.string().optional(),
    kind: z.enum(["select-one", "select-many", "confirm", "text-input"]),
    subject: z.string(),
    prompt: z.string().optional(),
    options: z.array(interactionOptionSchema).readonly().optional(),
    defaultValue: z
      .union([z.string(), z.boolean(), z.array(z.string()).readonly()])
      .optional(),
  })
  .strict();

const interactionResponseSchema = z.union([
  z
    .object({
      kind: z.literal("accepted"),
      choiceId: z.string().optional(),
      choiceIds: z.array(z.string()).readonly().optional(),
      value: z.union([z.string(), z.boolean()]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cancelled"),
      reason: z.string(),
    })
    .strict(),
]);

export const InteractionEvent = {
  Requested: BusEvent.define(
    "interaction.requested",
    z
      .object({
        request: interactionRequestSchema,
        timestamp: z.number(),
      })
      .strict(),
  ),
  Resolved: BusEvent.define(
    "interaction.resolved",
    z
      .object({
        interactionId: z.string(),
        commandRunId: z.string(),
        clientInvocationId: z.string().optional(),
        response: interactionResponseSchema,
        timestamp: z.number(),
      })
      .strict(),
  ),
} as const;
