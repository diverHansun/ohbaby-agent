import type {
  Message,
  MessagePage,
  MessagePageOptions,
  MessageWithParts,
} from "./types.js";

interface Cursor {
  readonly createdAt: number;
  readonly id: string;
}

function scopeKey(options: MessagePageOptions): string {
  return options.scope === undefined
    ? "all"
    : JSON.stringify([options.scope.contextScopeId ?? null]);
}

export function decodeMessagePage(
  sessionId: string,
  options: MessagePageOptions,
  runId?: string,
): { limit: number; cursor?: Cursor } {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw Object.assign(
      new Error("Message page limit must be between 1 and 200"),
      { code: "INVALID_SESSION_QUERY" },
    );
  if (options.before === undefined) return { limit };
  try {
    if (options.before.length > 4096) throw new Error();
    const value = JSON.parse(
      Buffer.from(options.before, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      value.sessionId !== sessionId ||
      value.scope !== scopeKey(options) ||
      value.runId !== (runId ?? null) ||
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt) ||
      typeof value.id !== "string" ||
      value.id.length === 0
    )
      throw new Error();
    return { limit, cursor: { createdAt: value.createdAt, id: value.id } };
  } catch {
    throw Object.assign(new Error("Invalid message page cursor"), {
      code: "INVALID_SESSION_QUERY",
    });
  }
}

export function compareMessages(left: Message, right: Message): number {
  return (
    left.time.created - right.time.created ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

export function makeMessagePage(
  sessionId: string,
  options: MessagePageOptions,
  descending: MessageWithParts[],
  limit: number,
  runId?: string,
): MessagePage {
  const hasMore = descending.length > limit;
  const messages = descending.slice(0, limit).reverse();
  const first = messages.at(0)?.info;
  return {
    messages,
    hasMore,
    ...(first === undefined
      ? {}
      : { firstMessageId: first.id, lastMessageId: messages.at(-1)?.info.id }),
    ...(hasMore && first !== undefined
      ? {
          nextCursor: messageCursor(sessionId, first, options, runId),
        }
      : {}),
  };
}

export function messageCursor(
  sessionId: string,
  message: Message,
  options: MessagePageOptions = {},
  runId?: string,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      sessionId,
      scope: scopeKey(options),
      runId: runId ?? null,
      createdAt: message.time.created,
      id: message.id,
    }),
  ).toString("base64url");
}

export function validateMessageIds(messageIds: readonly string[]): void {
  if (
    messageIds.length > 200 ||
    messageIds.some((id) => typeof id !== "string" || id.length === 0)
  )
    throw new Error("Message IDs must contain at most 200 nonempty IDs");
}
