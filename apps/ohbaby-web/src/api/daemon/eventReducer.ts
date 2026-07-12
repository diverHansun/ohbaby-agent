import {
  isWebPassthroughCommandId,
  type UiEvent,
  type UiMessage,
  type UiSnapshot,
} from "ohbaby-sdk";
import type { CommandNotice, CommandOutput, ViewState } from "./wire.js";

const COMMAND_NOTICE_LIMIT = 8;
const COMMAND_NOTICE_TEXT_LIMIT = 1_200;

export function createInitialViewState(): ViewState {
  return {
    commandCatalogVersion: null,
    commandNotices: [],
    lastAppliedSeqNum: 0,
    reasoningByMessageId: {},
    snapshot: null,
  };
}

export function replaceSnapshot(
  snapshot: UiSnapshot,
  seqNum: number,
): ViewState {
  return {
    commandCatalogVersion: null,
    commandNotices: [],
    lastAppliedSeqNum: seqNum,
    reasoningByMessageId: {},
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
  const commandNotices = applyCommandEvent(state.commandNotices, event);
  if (event.type === "command.catalog.updated") {
    return {
      ...state,
      commandNotices,
      commandCatalogVersion: event.version,
      lastAppliedSeqNum: seqNum,
    };
  }
  const snapshot = state.snapshot;
  if (!snapshot) {
    return {
      ...state,
      commandNotices,
      lastAppliedSeqNum: seqNum,
    };
  }
  return {
    commandCatalogVersion: state.commandCatalogVersion,
    commandNotices,
    lastAppliedSeqNum: seqNum,
    reasoningByMessageId: applyReasoningEvent(
      state.reasoningByMessageId,
      event,
    ),
    snapshot: applyEventToSnapshot(snapshot, event),
  };
}

function applyReasoningEvent(
  reasoningByMessageId: ViewState["reasoningByMessageId"],
  event: UiEvent,
): ViewState["reasoningByMessageId"] {
  switch (event.type) {
    case "message.reasoning.delta":
      return {
        ...reasoningByMessageId,
        [event.messageId]: {
          content: event.content,
          folded: false,
        },
      };
    case "message.reasoning.end":
      return foldReasoning(
        reasoningByMessageId,
        event.messageId,
        event.content,
      );
    case "message.part.delta":
      return foldReasoning(reasoningByMessageId, event.messageId);
    case "message.updated":
      return foldReasoning(reasoningByMessageId, event.message.id);
    case "run.updated":
      return event.run.status.kind === "running" ? reasoningByMessageId : {};
    case "run.interrupted":
      return {};
    default:
      return reasoningByMessageId;
  }
}

function foldReasoning(
  reasoningByMessageId: ViewState["reasoningByMessageId"],
  messageId: string | undefined,
  content?: string,
): ViewState["reasoningByMessageId"] {
  if (messageId === undefined) {
    return reasoningByMessageId;
  }
  const hasExisting = Object.prototype.hasOwnProperty.call(
    reasoningByMessageId,
    messageId,
  );
  if (!hasExisting && content === undefined) {
    return reasoningByMessageId;
  }
  const existingContent = hasExisting
    ? reasoningByMessageId[messageId].content
    : "";
  return {
    ...reasoningByMessageId,
    [messageId]: {
      content: content ?? existingContent,
      folded: true,
    },
  };
}

function applyCommandEvent(
  notices: readonly CommandNotice[],
  event: UiEvent,
): readonly CommandNotice[] {
  switch (event.type) {
    case "command.started":
      return upsertCommandNotice(notices, {
        commandId: event.command.commandId,
        createdAt: new Date(event.timestamp).toISOString(),
        id: event.command.commandRunId,
        kind: "running",
        path: event.command.path,
        ...(event.command.sessionId === undefined
          ? {}
          : { sessionId: event.command.sessionId }),
        text: `/${event.command.path.join(" ")} running`,
      });
    case "command.result.delivered": {
      const existing = notices.find(
        (notice) => notice.id === event.commandRunId,
      );
      const content = commandOutputToNoticeContent(event.output);
      return upsertCommandNotice(notices, {
        commandId: existing?.commandId ?? event.commandRunId,
        createdAt:
          existing?.createdAt ?? new Date(event.timestamp).toISOString(),
        id: event.commandRunId,
        kind: "success",
        path: existing?.path ?? [],
        ...(existing?.sessionId === undefined
          ? {}
          : { sessionId: existing.sessionId }),
        ...content,
      });
    }
    case "command.failed": {
      const existing = notices.find(
        (notice) => notice.id === event.commandRunId,
      );
      return upsertCommandNotice(notices, {
        commandId: existing?.commandId ?? event.commandRunId,
        createdAt:
          existing?.createdAt ?? new Date(event.timestamp).toISOString(),
        id: event.commandRunId,
        kind: "error",
        path: existing?.path ?? [],
        ...(existing?.sessionId === undefined
          ? {}
          : { sessionId: existing.sessionId }),
        text: event.error.message,
      });
    }
    default:
      return notices;
  }
}

function upsertCommandNotice(
  notices: readonly CommandNotice[],
  notice: CommandNotice,
): readonly CommandNotice[] {
  const withoutExisting = notices.filter(
    (candidate) => candidate.id !== notice.id,
  );
  return [...withoutExisting, notice].slice(-COMMAND_NOTICE_LIMIT);
}

function commandOutputToNoticeContent(
  output: Extract<
    UiEvent,
    { readonly type: "command.result.delivered" }
  >["output"],
): Pick<CommandNotice, "markdown" | "output" | "text"> {
  if (output === undefined) {
    return { text: "Command completed" };
  }
  switch (output.kind) {
    case "markdown":
      return { markdown: truncateCommandOutput(output.markdown), output };
    case "text":
      return { output, text: truncateCommandOutput(output.text) };
    case "data":
      return {
        output,
        text: truncateCommandOutput(formatDataCommandOutput(output)),
      };
  }
}

function formatDataCommandOutput(
  output: Extract<CommandOutput, { readonly kind: "data" }>,
): string {
  switch (output.subject) {
    case "help":
      return formatHelpOutput(output.data);
    case "session.created":
      return formatSessionCreatedOutput(output.data);
    case "session.current":
      return formatKeyValueOutput("session", output.data.sessionId);
    case "status":
      return formatStatusOutput(output.data);
    default:
      return JSON.stringify(output.data, null, 2);
  }
}

function formatHelpOutput(data: Record<string, unknown>): string {
  const commands = asUnknownArray(data.commands);
  if (commands.length === 0) {
    const categories = asUnknownArray(data.categories);
    const lines = categories.flatMap((category) =>
      isRecord(category) ? asUnknownArray(category.commands) : [],
    );
    return formatCommandList(lines);
  }
  return formatCommandList(commands);
}

function formatCommandList(commands: readonly unknown[]): string {
  const lines = commands
    .map((command) => {
      if (!isRecord(command)) {
        return "";
      }
      const id =
        typeof command.id === "string"
          ? command.id
          : typeof command.commandId === "string"
            ? command.commandId
            : undefined;
      if (id && !isWebPassthroughCommandId(id)) {
        return "";
      }
      const path = asStringArray(command.path);
      const description =
        typeof command.description === "string" ? command.description : "";
      const label = path.length > 0 ? `/${path.join(" ")}` : "/";
      return `${label}${description ? ` - ${description}` : ""}`;
    })
    .filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : "commands: none";
}

function formatSessionCreatedOutput(data: Record<string, unknown>): string {
  const session = isRecord(data.session) ? data.session : undefined;
  const label =
    (session && typeof session.title === "string"
      ? session.title
      : undefined) ??
    (session && typeof session.id === "string" ? session.id : undefined);
  return label ? `new session: ${label}` : JSON.stringify(data, null, 2);
}

function formatStatusOutput(data: Record<string, unknown>): string {
  const permission = isRecord(data.permission) ? data.permission : undefined;
  const sessionId = data.sessionId;
  const lines = ["status"];
  if (typeof sessionId === "string") {
    lines.push(`session: ${sessionId}`);
  }
  if (permission) {
    const mode = typeof permission.mode === "string" ? permission.mode : "auto";
    const level =
      typeof permission.level === "string" ? permission.level : "default";
    lines.push(`permission: ${mode} · ${level}`);
  }
  return lines.length > 1 ? lines.join("\n") : JSON.stringify(data, null, 2);
}

function formatKeyValueOutput(label: string, value: unknown): string {
  return typeof value === "string"
    ? `${label}: ${value}`
    : JSON.stringify(value, null, 2);
}

function truncateCommandOutput(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= COMMAND_NOTICE_TEXT_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, COMMAND_NOTICE_TEXT_LIMIT - 3)}...`;
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asUnknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    case "prompt.submitted":
    case "prompt.updated":
      return {
        ...snapshot,
        prompts: upsertByKey(snapshot.prompts ?? [], event.prompt, "promptId"),
      };
    case "message.appended":
      return updateSessionMessages(snapshot, event.sessionId, (messages) =>
        upsertById(messages, event.message),
      );
    case "message.updated":
      return updateSessionMessages(snapshot, event.sessionId, (messages) =>
        finalizeMessage(messages, event.sessionId, event.message),
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
    case "goal.updated":
      return {
        ...snapshot,
        goals:
          event.goal === null
            ? (snapshot.goals ?? []).filter(
                (goal) => goal.sessionId !== event.sessionId,
              )
            : upsertByKey(
                snapshot.goals ?? [],
                { goal: event.goal, sessionId: event.sessionId },
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
    case "command.failed":
    case "command.catalog.updated":
    case "interaction.requested":
    case "interaction.resolved":
      return snapshot;
    case "command.result.delivered":
      return applyCommandResultToSnapshot(snapshot, event);
  }
  return snapshot;
}

function applyCommandResultToSnapshot(
  snapshot: UiSnapshot,
  event: Extract<UiEvent, { type: "command.result.delivered" }>,
): UiSnapshot {
  if (event.action?.kind !== "session.selected") {
    return snapshot;
  }
  const actionData = isRecord(event.action.data) ? event.action.data : {};
  const choiceId = asNonEmptyString(actionData.choiceId);
  return choiceId === undefined
    ? snapshot
    : { ...snapshot, activeSessionId: choiceId };
}

function finalizeMessage(
  messages: readonly UiMessage[],
  sessionId: string,
  message: UiMessage,
): readonly UiMessage[] {
  const streamingId = `streaming:${sessionId}`;
  const prunedMessages =
    message.id === streamingId
      ? messages
      : messages.filter((candidate) => candidate.id !== streamingId);
  return upsertById(prunedMessages, message);
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
