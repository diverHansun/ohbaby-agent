import type { MessageWithParts } from "../../core/message/index.js";
import { isSystemReminderMessage } from "../../core/message/origin.js";
import { isActivePart } from "../../core/context/filters.js";
import { isSummaryMessage } from "../../core/context/summary.js";
import {
  recoverTodoSnapshotFromMessages,
  type TodoItem,
  type TodoWorkScopeId,
  type TodoWorkScopeRegistry,
} from "../../tools/todo.js";
import {
  renderReminderText,
  type ReminderBody,
  type ReminderProvider,
} from "./index.js";

function reminderText(todos: readonly TodoItem[]): string {
  const unfinished = todos.filter((todo) => todo.status !== "completed");
  const prioritized = [
    ...unfinished.filter((todo) => todo.status === "in_progress"),
    ...unfinished.filter((todo) => todo.status === "pending"),
  ];
  return [
    "Current unfinished todos:",
    ...prioritized.map((todo) => `[${todo.status}] ${todo.content}`),
    "Use todo_read to read the complete list.",
  ].join("\n");
}

/** Keys carry scope/list identity and real trigger baselines, never a step counter. */
function todoKeyInScope(
  key: unknown,
  workScopeId: TodoWorkScopeId | undefined,
): readonly unknown[] | undefined {
  if (typeof key !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(key);
    return Array.isArray(value) &&
      value[0] === "todo:v1" &&
      value[1] === (workScopeId ?? null)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function latestCompactionId(
  history: readonly MessageWithParts[],
): string | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    for (const part of history[index].parts) {
      if (
        part.type === "text" &&
        part.metadata?.kind === "context-summary" &&
        typeof part.metadata.compactionId === "string"
      ) {
        return part.metadata.compactionId;
      }
    }
  }
  return undefined;
}

export function createTodoReminderProvider(
  workScopes: Pick<TodoWorkScopeRegistry, "resolve">,
): ReminderProvider {
  return {
    type: "todo",
    kind: "snapshot",
    audience: "both",
    collect(context): ReminderBody | undefined {
      // Children own their context scope even while the parent holds a Goal lease.
      const workScopeId =
        context.contextScopeId === undefined
          ? workScopes.resolve(context.sessionId)
          : undefined;
      const snapshot = recoverTodoSnapshotFromMessages(
        context.fullHistory,
        undefined,
        workScopeId,
      );
      if (
        !snapshot ||
        snapshot.todos.every((todo) => todo.status === "completed")
      )
        return undefined;

      const listKey = JSON.stringify(snapshot.todos);
      const text = reminderText(snapshot.todos);
      const visibleReminderText = renderReminderText(text);
      const toolText = snapshot.todos
        .map((todo) => `[${todo.status}] ${todo.content}`)
        .join("\n");
      let lastReminderAnchor: string | undefined;
      let listVisible = false;
      const assistants = new Set<string>();
      for (const message of context.history) {
        if (message.info.role === "assistant" && !isSummaryMessage(message)) {
          assistants.add(message.info.id);
          // Failed assistant projection contains only selected failure text, no tools.
          if (message.info.finish !== "error") {
            listVisible ||= message.parts.some(
              (part) =>
                isActivePart(part) &&
                part.type === "tool" &&
                (part.tool === "todo_read" || part.tool === "todo_write") &&
                part.state.status === "completed" &&
                part.state.metadata?.internalWorkScopeId === workScopeId &&
                part.state.output === toolText,
            );
          }
        }
        if (!isSystemReminderMessage(message)) continue;
        for (const part of message.parts) {
          if (
            !isActivePart(part) ||
            part.type !== "text" ||
            part.ignored ||
            part.text.trim() === "" ||
            part.metadata?.reminderType !== "todo"
          )
            continue;
          const key = todoKeyInScope(part.metadata.key, workScopeId);
          if (key === undefined) continue;
          const anchor = part.metadata.anchorAssistantId;
          if (typeof anchor === "string") lastReminderAnchor = anchor;
          listVisible ||=
            key[2] === listKey && part.text === visibleReminderText;
        }
      }

      const ids = [...assistants];
      const writeIndex = ids.indexOf(snapshot.assistantMessageId);
      const reminderIndex =
        lastReminderAnchor === undefined ? -1 : ids.indexOf(lastReminderAnchor);
      const sinceWrite =
        writeIndex < 0 ? ids.length : ids.length - writeIndex - 1;
      // A reminder precedes its anchor's response, so that response counts.
      const sinceReminder =
        reminderIndex < 0 ? ids.length : ids.length - reminderIndex;
      const compactionId = latestCompactionId(context.fullHistory);
      const missingAfterCompaction = compactionId !== undefined && !listVisible;
      if (!missingAfterCompaction && (sinceWrite < 10 || sinceReminder < 10))
        return undefined;

      return {
        key: JSON.stringify([
          "todo:v1",
          workScopeId ?? null,
          listKey,
          snapshot.assistantMessageId,
          lastReminderAnchor ?? null,
          missingAfterCompaction ? compactionId : null,
        ]),
        text,
      };
    },
  };
}
