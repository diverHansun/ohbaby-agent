import { getReminderAnchorId } from "../message/origin.js";
import type { MessageWithParts } from "../message/index.js";
import type { ModelOrigin } from "ohbaby-llm";
import { isActivePart } from "./filters.js";
import { serializeHistoryMessages } from "./serializer.js";

/**
 * Places each persisted reminder immediately before the assistant it anchors.
 * Reminders whose anchor is absent or projects nothing to the model are hidden,
 * never moved to the tail; storage time order is not used for them.
 */
export function arrangeReminderHistory(
  history: readonly MessageWithParts[],
  activeReasoningByMessageId?: ReadonlyMap<string, string>,
  modelOrigin?: ModelOrigin,
): MessageWithParts[] {
  const remindersByAnchor = new Map<string, MessageWithParts[]>();
  const others: MessageWithParts[] = [];
  for (const message of history) {
    const anchor = getReminderAnchorId(message);
    if (anchor === undefined) {
      others.push(message);
      continue;
    }
    const anchored = remindersByAnchor.get(anchor) ?? [];
    const parts = message.parts.filter(isActivePart);
    if (parts.length > 0) anchored.push({ info: message.info, parts });
    remindersByAnchor.set(anchor, anchored);
  }
  if (remindersByAnchor.size === 0) return others;

  return others.flatMap((message) => {
    const reminders =
      message.info.role === "assistant"
        ? remindersByAnchor.get(message.info.id)
        : undefined;
    return reminders !== undefined &&
      serializeHistoryMessages(
        [message],
        activeReasoningByMessageId,
        modelOrigin,
      ).length > 0
      ? [...reminders, message]
      : [message];
  });
}
