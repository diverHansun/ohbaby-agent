import type { UiEvent, UiMessage, UiSnapshot } from "ohbaby-sdk";
import type { ViewState } from "./wire.js";

export function createInitialViewState(): ViewState {
  return {
    lastAppliedSeqNum: 0,
    snapshot: null,
  };
}

export function replaceSnapshot(
  snapshot: UiSnapshot,
  seqNum: number,
): ViewState {
  return {
    lastAppliedSeqNum: seqNum,
    snapshot,
  };
}

export function reduceUiEvent(
  state: ViewState,
  event: UiEvent,
  seqNum: number,
): ViewState {
  if (seqNum <= state.lastAppliedSeqNum) {
    return state;
  }
  if (event.type === "snapshot.replaced") {
    return replaceSnapshot(event.snapshot, seqNum);
  }
  const snapshot = state.snapshot;
  if (!snapshot) {
    return {
      ...state,
      lastAppliedSeqNum: seqNum,
    };
  }
  return {
    lastAppliedSeqNum: seqNum,
    snapshot: applyEventToSnapshot(snapshot, event),
  };
}

function applyEventToSnapshot(
  snapshot: UiSnapshot,
  event: UiEvent,
): UiSnapshot {
  switch (event.type) {
    case "runtime.updated":
      return { ...snapshot, status: event.status };
    case "permission.updated":
      return { ...snapshot, permission: event.permission };
    case "session.updated":
      return {
        ...snapshot,
        sessions: upsertById(snapshot.sessions, event.session),
      };
    case "message.appended":
      return updateSessionMessages(snapshot, event.sessionId, (messages) => [
        ...messages,
        event.message,
      ]);
    case "message.updated":
      return updateSessionMessages(snapshot, event.sessionId, (messages) =>
        upsertById(messages, event.message),
      );
    case "message.part.delta":
      return updateSessionMessages(snapshot, event.sessionId, (messages) =>
        applyMessageDelta(messages, event),
      );
    case "run.updated":
      return {
        ...snapshot,
        runs: upsertById(snapshot.runs, event.run),
        status: event.run.status,
      };
    case "run.interrupted":
      return {
        ...snapshot,
        status: { kind: "idle" },
      };
    case "context.window.updated":
      return {
        ...snapshot,
        contextWindowUsages: upsertByKey(
          snapshot.contextWindowUsages ?? [],
          event.usage,
          "sessionId",
        ),
      };
    case "permission.requested":
      return {
        ...snapshot,
        permissions: upsertById(snapshot.permissions, event.request),
        status: {
          kind: "waiting-for-permission",
          requestId: event.request.id,
        },
      };
    case "permission.resolved":
      return {
        ...snapshot,
        permissions: snapshot.permissions.filter(
          (permission) => permission.id !== event.requestId,
        ),
        status:
          snapshot.status.kind === "waiting-for-permission" &&
          snapshot.status.requestId === event.requestId
            ? { kind: "idle" }
            : snapshot.status,
      };
    case "notice.emitted":
    case "command.started":
    case "command.result.delivered":
    case "command.failed":
    case "command.catalog.updated":
    case "interaction.requested":
    case "interaction.resolved":
      return snapshot;
  }
  return snapshot;
}

function upsertById<T extends { readonly id: string }>(
  items: readonly T[],
  item: T,
): readonly T[] {
  return upsertByKey(items, item, "id");
}

function upsertByKey<T extends Record<K, string>, K extends keyof T>(
  items: readonly T[],
  item: T,
  key: K,
): readonly T[] {
  const index = items.findIndex((candidate) => candidate[key] === item[key]);
  if (index < 0) {
    return [...items, item];
  }
  return [...items.slice(0, index), item, ...items.slice(index + 1)];
}

function updateSessionMessages(
  snapshot: UiSnapshot,
  sessionId: string,
  update: (messages: readonly UiMessage[]) => readonly UiMessage[],
): UiSnapshot {
  return {
    ...snapshot,
    sessions: snapshot.sessions.map((session) =>
      session.id === sessionId
        ? { ...session, messages: update(session.messages) }
        : session,
    ),
  };
}

function applyMessageDelta(
  messages: readonly UiMessage[],
  event: Extract<UiEvent, { type: "message.part.delta" }>,
): readonly UiMessage[] {
  const messageId = event.messageId ?? `streaming:${event.sessionId}`;
  const index = messages.findIndex((message) => message.id === messageId);
  const current =
    index >= 0
      ? messages[index]
      : ({
          createdAt: new Date(event.timestamp ?? Date.now()).toISOString(),
          id: messageId,
          parts: [],
          role: "assistant",
          status: "streaming",
        } satisfies UiMessage);
  const nextMessage = {
    ...current,
    parts: upsertTextPart(current.parts, event.delta, event.content),
    status: "streaming" as const,
  };
  if (index < 0) {
    return [...messages, nextMessage];
  }
  return [
    ...messages.slice(0, index),
    nextMessage,
    ...messages.slice(index + 1),
  ];
}

function upsertTextPart(
  parts: UiMessage["parts"],
  delta: string,
  content: string | undefined,
): UiMessage["parts"] {
  let index = -1;
  for (let candidate = parts.length - 1; candidate >= 0; candidate -= 1) {
    if (parts[candidate]?.type === "text") {
      index = candidate;
      break;
    }
  }
  if (index < 0) {
    return [...parts, { text: content ?? delta, type: "text" }];
  }
  const part = parts[index];
  if (part.type !== "text") {
    return parts;
  }
  return [
    ...parts.slice(0, index),
    { text: content ?? `${part.text}${delta}`, type: "text" },
    ...parts.slice(index + 1),
  ];
}
