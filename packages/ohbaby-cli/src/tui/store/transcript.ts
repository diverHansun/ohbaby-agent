import type { UiMessage } from "ohbaby-sdk";
import type { TuiRuntimeStatus } from "./snapshot.js";

export interface TranscriptSplit {
  readonly committedMessages: readonly UiMessage[];
  readonly liveMessage: UiMessage | null;
}

/**
 * One append-only entry of the committed transcript. Whole messages map to a
 * single item; a streaming message is committed progressively as fragment
 * items so finished parts reach the terminal scrollback (via <Static>) while
 * the rest of the message is still being generated.
 */
export interface TranscriptItem {
  readonly id: string;
  readonly messageId: string;
  readonly message: UiMessage;
  /** Render a bottom margin: true for whole messages and final fragments. */
  readonly spacing: boolean;
}

export interface TranscriptCommitState {
  readonly committedItems: readonly TranscriptItem[];
  /** Parts already committed per fragmented message id. */
  readonly committedPartCounts: Readonly<Partial<Record<string, number>>>;
  readonly liveMessage: UiMessage | null;
}

/**
 * Advances the committed transcript: emits new items for messages that have
 * committed wholesale and fragment items for the sealed prefix of the live
 * message. Items are append-only (committed output is frozen in scrollback),
 * so previously committed parts are never re-emitted, and the returned arrays
 * keep their previous references when nothing changed.
 */
export function advanceTranscriptCommit(
  previous: TranscriptCommitState | undefined,
  messages: readonly UiMessage[],
  runtime: TuiRuntimeStatus,
): TranscriptCommitState {
  const split = splitTranscript(messages, runtime);
  const previousItems = previous?.committedItems ?? [];
  const previousCounts = previous?.committedPartCounts ?? {};
  const items = [...previousItems];
  const counts: Partial<Record<string, number>> = { ...previousCounts };
  const itemIndexById = new Map(
    previousItems.map((item, index) => [item.id, index] as const),
  );
  const committedMessageIds = new Set(
    previousItems.map((item) => item.messageId),
  );
  let changed = false;

  const appendItem = (item: TranscriptItem): void => {
    itemIndexById.set(item.id, items.length);
    items.push(item);
    committedMessageIds.add(item.messageId);
    changed = true;
  };

  for (const message of split.committedMessages) {
    const committedParts = counts[message.id];
    if (committedParts !== undefined) {
      if (committedParts < message.parts.length) {
        appendItem(
          fragmentItem(message, committedParts, message.parts.length, true),
        );
        counts[message.id] = message.parts.length;
      } else if (needsFinalItem(items, message)) {
        appendItem(finalItem(message));
      }
      continue;
    }

    if (committedMessageIds.has(message.id)) {
      // A whole-committed message changed after the fact (e.g. a late delta
      // or canonical update). Refresh the item in place so the dynamic
      // (non-Static) transcript re-renders it; the Static path keeps showing
      // the frozen output, exactly as before.
      const index = itemIndexById.get(message.id);
      if (
        index !== undefined &&
        items[index].message !== message &&
        needsFinalItem(items, message)
      ) {
        appendItem(finalItem(message));
        continue;
      }
      if (index !== undefined && items[index].message !== message) {
        items[index] = { ...items[index], message };
        changed = true;
      }
      continue;
    }
    appendItem({
      id: message.id,
      message,
      messageId: message.id,
      spacing: true,
    });
  }

  let liveMessage: UiMessage | null = null;
  if (split.liveMessage !== null) {
    const live = split.liveMessage;
    if (itemIndexById.has(live.id)) {
      return unchangedOrNext(previous, changed, items, counts, null);
    }

    const alreadyCommitted = counts[live.id] ?? 0;
    const start = Math.min(
      live.parts.length,
      Math.max(alreadyCommitted, computeLiveStartIndex(live)),
    );

    if (start > alreadyCommitted) {
      appendItem(fragmentItem(live, alreadyCommitted, start, false));
      counts[live.id] = start;
    }

    if (start === 0) {
      liveMessage = live;
    } else if (start < live.parts.length) {
      liveMessage = reuseLiveMessage(previous?.liveMessage ?? null, {
        ...live,
        parts: live.parts.slice(start),
      });
    }
  }

  return unchangedOrNext(previous, changed, items, counts, liveMessage);
}

/**
 * Index of the first part of a streaming message that may still change.
 * Everything before it is "sealed" and safe to freeze into the scrollback:
 * text and reasoning parts once a later part exists, tool calls once they
 * reached a terminal status and their result is present. A tool call is never
 * separated from its result across the committed/live boundary.
 */
export function computeLiveStartIndex(message: UiMessage): number {
  const parts = message.parts;
  const lastIndex = parts.length - 1;
  const resultIndexByCallId = new Map<string, number>();
  parts.forEach((part, index) => {
    if (
      part.type === "tool-result" &&
      !resultIndexByCallId.has(part.result.callId)
    ) {
      resultIndexByCallId.set(part.result.callId, index);
    }
  });

  const sealed = (index: number): boolean => {
    const part = parts[index];
    switch (part.type) {
      case "text":
      case "reasoning":
        return index < lastIndex;
      case "tool-call":
        return (
          (part.call.status === "completed" || part.call.status === "failed") &&
          resultIndexByCallId.has(part.call.id)
        );
      case "tool-result":
        return true;
    }
  };

  let start = 0;
  while (start < parts.length && sealed(start)) {
    start += 1;
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < start; index += 1) {
      const part = parts[index];
      if (part.type !== "tool-call") {
        continue;
      }
      const resultIndex = resultIndexByCallId.get(part.call.id);
      if (resultIndex !== undefined && resultIndex >= start) {
        start = index;
        changed = true;
        break;
      }
    }
  }

  return start;
}

function fragmentItem(
  message: UiMessage,
  from: number,
  to: number,
  spacing: boolean,
): TranscriptItem {
  return {
    id: `${message.id}#${String(from)}-${String(to)}`,
    // Fragments are frozen; "completed" also collapses sealed reasoning parts
    // to their summary form instead of freezing the full reasoning text.
    message: {
      ...message,
      parts: message.parts.slice(from, to),
      status: "completed",
    },
    messageId: message.id,
    spacing,
  };
}

function finalItem(message: UiMessage): TranscriptItem {
  return {
    id: finalItemId(message.id),
    message: {
      ...message,
      parts: [],
      status: "completed",
    },
    messageId: message.id,
    spacing: true,
  };
}

function finalItemId(messageId: string): string {
  return `${messageId}#final`;
}

function needsFinalItem(
  items: readonly TranscriptItem[],
  message: UiMessage,
): boolean {
  const hasFinalSpacing = items.some(
    (item) => item.messageId === message.id && item.spacing,
  );
  if (!hasFinalSpacing) {
    return true;
  }

  return (
    isLengthTruncatedAssistant(message) &&
    !hasTruncationMarker(items, message.id)
  );
}

function hasTruncationMarker(
  items: readonly TranscriptItem[],
  messageId: string,
): boolean {
  return items.some(
    (item) =>
      item.messageId === messageId && isLengthTruncatedAssistant(item.message),
  );
}

function isLengthTruncatedAssistant(message: UiMessage): boolean {
  return (
    message.role === "assistant" &&
    message.status === "completed" &&
    message.finishReason === "length"
  );
}

function unchangedOrNext(
  previous: TranscriptCommitState | undefined,
  changed: boolean,
  committedItems: readonly TranscriptItem[],
  committedPartCounts: Readonly<Partial<Record<string, number>>>,
  liveMessage: UiMessage | null,
): TranscriptCommitState {
  if (!changed && previous !== undefined) {
    return {
      committedItems: previous.committedItems,
      committedPartCounts: previous.committedPartCounts,
      liveMessage,
    };
  }

  return {
    committedItems,
    committedPartCounts,
    liveMessage,
  };
}

function reuseLiveMessage(
  previous: UiMessage | null,
  next: UiMessage,
): UiMessage {
  if (previous?.id !== next.id) {
    return next;
  }

  if (
    previous.status !== next.status ||
    previous.parts.length !== next.parts.length ||
    !previous.parts.every((part, index) => part === next.parts[index])
  ) {
    return next;
  }
  return previous;
}

export function splitTranscript(
  messages: readonly UiMessage[],
  runtime: TuiRuntimeStatus,
): TranscriptSplit {
  const last = messages.at(-1);
  if (!last || runtime.kind === "idle" || runtime.kind === "error") {
    return { committedMessages: messages, liveMessage: null };
  }

  if (
    runtime.kind === "waiting-for-permission" &&
    hasPendingOrRunningTool(last)
  ) {
    return liveTail(messages, last);
  }

  if (last.role === "user") {
    return { committedMessages: messages, liveMessage: null };
  }

  const isAssistant = last.role === "assistant";
  if (!isAssistant) {
    return { committedMessages: messages, liveMessage: null };
  }

  if (last.status === "streaming" || hasPendingOrRunningTool(last)) {
    return liveTail(messages, last);
  }

  if (runtime.kind === "running") {
    return liveTail(messages, last);
  }

  return { committedMessages: messages, liveMessage: null };
}

function liveTail(
  messages: readonly UiMessage[],
  liveMessage: UiMessage,
): TranscriptSplit {
  return {
    committedMessages: messages.slice(0, -1),
    liveMessage,
  };
}

function hasPendingOrRunningTool(message: UiMessage): boolean {
  return message.parts.some(
    (part) =>
      part.type === "tool-call" &&
      (part.call.status === "pending" || part.call.status === "running"),
  );
}
