import type { UiContextWindowUsage } from "./context-window.js";
import type { UiPromptReceipt, UiPromptSubmission } from "./prompt.js";
import type {
  UiGoal,
  UiMessage,
  UiRun,
  UiSession,
  UiSessionTodoList,
} from "./snapshot.js";

/** Tokens are opaque identities. Only revisions within the same identity compare. */
export interface UiSessionVersion {
  readonly runtimeEpoch: string;
  readonly sessionId: string;
  readonly viewGeneration: string;
  readonly sessionRevision: number;
}
export interface UiSessionScope {
  readonly sessionId: string;
  readonly runtimeEpoch?: string;
  readonly bindingGeneration?: number;
  readonly signal?: AbortSignal;
}
export type UiOptionalRead<T> =
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "unavailable"; readonly reason: string };
export interface UiHistoryBoundary {
  readonly before?: string;
  readonly hasMore: boolean;
}
export interface UiSessionView {
  readonly serverNow?: number;
  readonly version: UiSessionVersion;
  readonly bindingGeneration?: number;
  readonly session: UiSession;
  readonly runs: readonly UiRun[];
  readonly prompts: readonly UiPromptSubmission[];
  readonly history: UiHistoryBoundary;
  readonly reasoningMissing: boolean;
  readonly todo: UiOptionalRead<UiSessionTodoList | null>;
  readonly goal: UiOptionalRead<UiGoal | null>;
  readonly context: UiOptionalRead<UiContextWindowUsage | null>;
}
export interface UiSessionHistory extends UiHistoryBoundary {
  readonly serverNow?: number;
  readonly version: UiSessionVersion;
  readonly bindingGeneration?: number;
  readonly messages: readonly UiMessage[];
  readonly prompts: readonly UiPromptSubmission[];
  readonly reasoningMissing: boolean;
}
export interface UiSessionControl {
  readonly runtimeEpoch: string;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly bindingGeneration?: number;
  readonly runId: string | null;
  readonly driver: "user" | "goal" | null;
}
export interface UiPromptReceiptQuery {
  readonly clientRequestId: string;
  readonly sessionId?: string;
  readonly runtimeEpoch?: string;
  readonly bindingGeneration?: number;
  readonly signal?: AbortSignal;
}
export interface UiPromptReceiptResult {
  readonly runtimeEpoch: string;
  readonly clientRequestId: string;
  readonly bindingGeneration?: number;
  readonly receipt: UiPromptReceipt | null;
}
export interface UiSessionTextAppend {
  readonly messageId: string;
  readonly partId: string;
  /** String.length offset (UTF-16 code units), not bytes or Unicode code points. */
  readonly offset: number;
  readonly text: string;
}
export interface UiSessionChangedEvent {
  readonly serverNow?: number;
  readonly type: "session.changed";
  readonly version: UiSessionVersion;
  readonly bindingGeneration?: number;
  readonly messages?: readonly UiMessage[];
  readonly textAppends?: readonly UiSessionTextAppend[];
  readonly removedMessageIds?: readonly string[];
  readonly evictedMessageIds?: readonly string[];
  readonly history?: UiHistoryBoundary;
  readonly session?: Omit<UiSession, "messages">;
  readonly runs?: readonly UiRun[];
  readonly prompts?: readonly UiPromptSubmission[];
  readonly reasoningMissing?: boolean;
  readonly todo?: UiSessionView["todo"];
  readonly goal?: UiSessionView["goal"];
  readonly context?: UiSessionView["context"];
  readonly historyInvalidated?: boolean;
}
export interface UiSessionUnavailableEvent {
  readonly type: "session.unavailable";
  /** Present on generation-aware sources; omitted by older transports. */
  readonly viewGeneration?: string;
  readonly sessionId: string;
  readonly runtimeEpoch: string;
  readonly bindingGeneration?: number;
  readonly reason: string;
}
export interface UiSessionIndexInvalidatedEvent {
  readonly type: "session.index.invalidated";
  readonly selectedSessionId?: string | null;
}
export interface UiModelInvalidatedEvent {
  readonly type: "model.invalidated";
}
export type UiSessionRecoveryEvent =
  | UiSessionChangedEvent
  | UiSessionUnavailableEvent;
export interface UiSessionRecoveryClient {
  getSessionView(input: UiSessionScope): Promise<UiSessionView>;
  getSessionHistory(
    input: UiSessionScope & {
      readonly before?: string;
      readonly limit?: number;
    },
  ): Promise<UiSessionHistory>;
  getSessionControl(input: UiSessionScope): Promise<UiSessionControl>;
  getPromptReceipt(input: UiPromptReceiptQuery): Promise<UiPromptReceiptResult>;
}
export function sameSessionGeneration(
  left: UiSessionVersion,
  right: UiSessionVersion,
): boolean {
  return (
    left.runtimeEpoch === right.runtimeEpoch &&
    left.sessionId === right.sessionId &&
    left.viewGeneration === right.viewGeneration
  );
}
export function applySessionChange(
  view: UiSessionView,
  event: UiSessionChangedEvent,
): UiSessionView | undefined {
  if (!sameSessionGeneration(view.version, event.version)) return undefined;
  if (event.version.sessionRevision <= view.version.sessionRevision)
    return view;
  if (event.version.sessionRevision !== view.version.sessionRevision + 1)
    return undefined;
  const removed = new Set([
    ...(event.removedMessageIds ?? []),
    ...(event.evictedMessageIds ?? []),
  ]);
  const messages = new Map(
    view.session.messages
      .filter((message) => !removed.has(message.id))
      .map((message) => [message.id, message]),
  );
  for (const message of event.messages ?? []) messages.set(message.id, message);
  const replaced = new Set((event.messages ?? []).map((message) => message.id));
  for (const append of event.textAppends ?? []) {
    if (
      typeof append.messageId !== "string" ||
      !append.messageId ||
      typeof append.partId !== "string" ||
      !append.partId
    )
      return undefined;
    const message = messages.get(append.messageId);
    if (!message || replaced.has(append.messageId)) return undefined;
    const targets = message.parts.filter((part) => part.id === append.partId);
    const part = targets[0];
    if (
      targets.length !== 1 ||
      (part.type !== "text" && part.type !== "reasoning") ||
      !Number.isSafeInteger(append.offset) ||
      append.offset !== part.text.length ||
      typeof append.text !== "string"
    )
      return undefined;
    messages.set(message.id, {
      ...message,
      parts: message.parts.map((candidate) =>
        candidate === part
          ? { ...part, text: part.text + append.text }
          : candidate,
      ),
    });
  }
  return {
    ...view,
    version: event.version,
    serverNow: event.serverNow ?? view.serverNow,
    session: {
      ...view.session,
      ...event.session,
      messages: [...messages.values()].sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      ),
    },
    runs: event.runs ?? view.runs,
    history: event.history ?? view.history,
    prompts: event.prompts ?? view.prompts,
    reasoningMissing: event.reasoningMissing ?? view.reasoningMissing,
    todo: event.todo ?? view.todo,
    goal: event.goal ?? view.goal,
    context: event.context ?? view.context,
  };
}
