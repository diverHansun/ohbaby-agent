import { z } from "zod";
import { BusEvent } from "../bus/index.js";

export const ModeSchema = z.union([
  z.literal("ask"),
  z.literal("plan"),
  z.literal("agent"),
]);

export const AgentStateSchema = z.union([
  z.literal("ask-before-edit"),
  z.literal("edit-automatically"),
]);

export const PolicyEvent = {
  ModeChanged: BusEvent.define(
    "policy.mode-changed",
    z.object({
      previousMode: ModeSchema,
      currentMode: ModeSchema,
    }),
  ),
  AgentStateChanged: BusEvent.define(
    "policy.agent-state-changed",
    z.object({
      previousState: AgentStateSchema,
      currentState: AgentStateSchema,
    }),
  ),
} as const;
