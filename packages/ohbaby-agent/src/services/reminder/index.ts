import type { EnvironmentInfo } from "../../core/system-prompt/types.js";
import type { MessageWithParts } from "../../core/message/index.js";
import { isSystemReminderMessage } from "../../core/message/origin.js";
import { arrangeReminderHistory } from "../../core/context/reminder-history.js";

export type ReminderAudience = "primary" | "subagent" | "both";
export const REMINDER_ORDER = [
  "environment",
  "mode",
  "mcp-catalog",
  "todo",
  "skill-usage",
] as const;
export type ReminderType = (typeof REMINDER_ORDER)[number];

export interface ReminderContext {
  readonly environment?: EnvironmentInfo;
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly isSubagent: boolean;
  readonly agentName?: string;
  /** Effective model history of this scope, with reminders in anchor order. */
  readonly history: readonly MessageWithParts[];
  /** Same ledger-filtered read, retaining compacted parts for event facts. */
  readonly fullHistory: readonly MessageWithParts[];
  readonly protectedInputs: readonly MessageWithParts[];
}

export interface ReminderBody {
  readonly key: string;
  /** Host-formatted body; external values must already be escaped. */
  readonly text: string;
}

export interface ReminderProvider {
  readonly type: ReminderType;
  readonly kind: "snapshot" | "event";
  readonly audience: ReminderAudience;
  collect(
    context: ReminderContext,
  ): Promise<ReminderBody | undefined> | ReminderBody | undefined;
}

export interface ReminderDraft extends ReminderBody {
  readonly type: ReminderType;
}

export type ReminderCollector = (
  context: ReminderContext,
) => Promise<readonly ReminderDraft[]>;

/** Providers share one scoped history read. Optional source failures skip that source. */
export function createReminderCollector(
  providers: readonly ReminderProvider[],
): ReminderCollector {
  const ordered = [...providers].sort(
    (a, b) => REMINDER_ORDER.indexOf(a.type) - REMINDER_ORDER.indexOf(b.type),
  );
  return async (input) => {
    const inScope = (message: MessageWithParts): boolean =>
      message.info.sessionId === input.sessionId &&
      message.info.contextScopeId === input.contextScopeId;
    const context: ReminderContext = {
      ...input,
      history: input.history.filter(inScope),
      fullHistory: input.fullHistory.filter(inScope),
      protectedInputs: input.protectedInputs.filter(inScope),
    };
    const latest = new Map<string, string>();
    for (const message of context.history) {
      if (!isSystemReminderMessage(message)) continue;
      for (const part of message.parts) {
        if (part.type !== "text" || part.ignored || part.text.trim() === "")
          continue;
        latest.set(
          String(part.metadata?.reminderType),
          String(part.metadata?.key),
        );
      }
    }
    // Event facts survive retirement. Replay their original owners, including the
    // existing failed-history policy; a saved reminder alone is never evidence.
    // Deliberately use each saved native state's original origin, not the current
    // model: an applied event survives a later source switch. The serializer
    // still rejects native-only owners without a completed timestamp.
    const historical = arrangeReminderHistory(
      context.fullHistory.map((message) => ({
        info: message.info,
        parts: message.parts.map((part) => ({
          ...part,
          time: { ...part.time, compacted: undefined },
        })),
      })),
    );
    const events = new Map<string, Set<string>>();
    for (const message of historical) {
      if (!isSystemReminderMessage(message)) continue;
      for (const part of message.parts) {
        const type = String(part.metadata?.reminderType);
        const keys = events.get(type) ?? new Set<string>();
        keys.add(String(part.metadata?.key));
        events.set(type, keys);
      }
    }
    const audience = context.isSubagent ? "subagent" : "primary";
    const eligible = ordered.filter(
      (provider) =>
        provider.audience === "both" || provider.audience === audience,
    );
    const bodies = await Promise.all(
      eligible.map(async (provider) => {
        try {
          return await provider.collect(context);
        } catch {
          return undefined;
        }
      }),
    );
    const emitted = new Set<ReminderType>();
    return eligible.flatMap((provider, index) => {
      const body = bodies[index];
      if (
        body === undefined ||
        body.text.trim() === "" ||
        body.key.trim() === "" ||
        emitted.has(provider.type)
      )
        return [];
      emitted.add(provider.type);
      const duplicate =
        provider.kind === "snapshot"
          ? latest.get(provider.type) === body.key
          : events.get(provider.type)?.has(body.key);
      return duplicate
        ? []
        : [{ type: provider.type, key: body.key, text: body.text }];
    });
  };
}
