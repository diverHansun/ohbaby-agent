import type {
  UiHistoryBoundary,
  UiMessage,
  UiSubagentConversationQuery,
} from "ohbaby-sdk";
import type {
  SubagentExecutionRecord,
  SubagentExecutionStore,
} from "../../agents/subagents/execution-store.js";
import type {
  Message,
  MessageManager,
  MessageWithParts,
} from "../../core/message/types.js";
import { messageCursor } from "../../core/message/pagination.js";

interface HistoryCursor {
  readonly version: 1;
  readonly rootSessionId: string;
  readonly subagentId: string;
  readonly executionId: string;
  readonly sequence: number;
  readonly kind: "parent" | "message" | "segment";
  readonly messageId: string;
  readonly messageCursor?: string;
}

interface HistoryItem {
  readonly record: SubagentExecutionRecord;
  readonly message: UiMessage;
  readonly cursor: HistoryCursor;
}

function invalidCursor(): Error {
  return Object.assign(new Error("Invalid subagent conversation cursor"), {
    code: "INVALID_SESSION_QUERY",
  });
}

function encode(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decode(
  value: string,
  query: UiSubagentConversationQuery,
): HistoryCursor {
  try {
    if (value.length > 4096) throw new Error();
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      parsed.rootSessionId !== query.rootSessionId ||
      parsed.subagentId !== query.subagentId ||
      typeof parsed.executionId !== "string" ||
      !Number.isSafeInteger(parsed.sequence) ||
      typeof parsed.sequence !== "number" ||
      parsed.sequence < 0 ||
      typeof parsed.messageId !== "string" ||
      !parsed.messageId ||
      (parsed.kind !== "parent" &&
        parsed.kind !== "message" &&
        parsed.kind !== "segment") ||
      (parsed.kind === "message" && typeof parsed.messageCursor !== "string")
    )
      throw new Error();
    return parsed as unknown as HistoryCursor;
  } catch {
    throw invalidCursor();
  }
}

export function parentMessage(
  record: SubagentExecutionRecord,
): UiMessage | undefined {
  if (!record.childUserMessageId) return undefined;
  return {
    id: record.childUserMessageId,
    role: "user",
    createdAt: new Date(record.createdAt).toISOString(),
    parts: record.prompt
      ? [
          {
            id: `${record.childUserMessageId}:text`,
            type: "text",
            text: record.prompt,
          },
        ]
      : [],
  };
}

export function createSubagentConversationHistory(options: {
  readonly executions: Pick<SubagentExecutionStore, "list" | "getForRoot">;
  readonly messages: MessageManager;
  readonly project: (message: MessageWithParts) => UiMessage | undefined;
}): {
  read(query: UiSubagentConversationQuery): Promise<{
    messages: UiMessage[];
    history: UiHistoryBoundary & { after?: string; hasLater: boolean };
    executions: SubagentExecutionRecord[];
    anchorMessageId?: string;
    anchorFound: boolean;
  }>;
} {
  const owned = (
    record: SubagentExecutionRecord | null,
    query: UiSubagentConversationQuery,
  ): SubagentExecutionRecord => {
    if (
      record?.rootSessionId !== query.rootSessionId ||
      record.subagentId !== query.subagentId
    )
      throw invalidCursor();
    return record;
  };

  async function parent(
    record: SubagentExecutionRecord,
  ): Promise<UiMessage | undefined> {
    const synthetic = parentMessage(record);
    if (!synthetic || !record.childSessionId) return synthetic;
    const persisted = (
      await options.messages.listByIds(record.childSessionId, [synthetic.id])
    ).at(0);
    if (
      persisted === undefined ||
      persisted.info.contextScopeId !== record.childScopeId ||
      (persisted.info.runId !== undefined &&
        record.childRunId !== undefined &&
        persisted.info.runId !== record.childRunId)
    )
      return synthetic;
    return options.project(persisted) ?? synthetic;
  }

  function cursorFor(
    record: SubagentExecutionRecord,
    message: Message,
    kind: "parent" | "message",
  ): HistoryCursor {
    return {
      version: 1,
      rootSessionId: record.rootSessionId,
      subagentId: record.subagentId,
      executionId: record.executionId,
      sequence: record.delegationSequence ?? 0,
      kind,
      messageId: message.id,
      ...(kind === "message" && record.childSessionId
        ? {
            messageCursor: messageCursor(
              record.childSessionId,
              message,
              { scope: { contextScopeId: record.childScopeId } },
              record.childRunId,
            ),
          }
        : {}),
    };
  }

  function segmentCursor(record: SubagentExecutionRecord): HistoryCursor {
    return {
      version: 1,
      rootSessionId: record.rootSessionId,
      subagentId: record.subagentId,
      executionId: record.executionId,
      sequence: record.delegationSequence ?? 0,
      kind: "segment",
      messageId: record.executionId,
    };
  }

  async function adjacent(
    record: SubagentExecutionRecord,
    query: UiSubagentConversationQuery,
    forward: boolean,
  ): Promise<SubagentExecutionRecord | undefined> {
    const scope = {
      rootSessionId: query.rootSessionId,
      subagentId: query.subagentId,
      limit: 1,
    } as const;
    if (record.delegationSequence === undefined) {
      const legacy = await options.executions.list({
        ...scope,
        legacyOnly: true,
        ...(forward
          ? {
              after: {
                createdAt: record.createdAt,
                executionId: record.executionId,
              },
              ascending: true,
            }
          : {
              before: {
                createdAt: record.createdAt,
                executionId: record.executionId,
              },
            }),
      });
      if (legacy[0]) return owned(legacy[0], query);
      if (!forward) return undefined;
      const modern = await options.executions.list({
        ...scope,
        afterSequence: 0,
        ascending: true,
      });
      return modern[0] ? owned(modern[0], query) : undefined;
    }
    const modern = await options.executions.list({
      ...scope,
      ...(forward
        ? { afterSequence: record.delegationSequence, ascending: true }
        : { beforeSequence: record.delegationSequence }),
    });
    if (modern[0]) return owned(modern[0], query);
    if (forward) return undefined;
    const legacy = await options.executions.list({
      ...scope,
      legacyOnly: true,
    });
    return legacy[0] ? owned(legacy[0], query) : undefined;
  }

  return {
    async read(query): Promise<{
      messages: UiMessage[];
      history: UiHistoryBoundary & { after?: string; hasLater: boolean };
      executions: SubagentExecutionRecord[];
      anchorMessageId?: string;
      anchorFound: boolean;
    }> {
      query.signal?.throwIfAborted();
      const limit = query.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw Object.assign(new Error("Page limit must be between 1 and 100"), {
          code: "INVALID_SESSION_QUERY",
        });
      if (query.before !== undefined && query.after !== undefined)
        throw invalidCursor();
      const boundary =
        query.before !== undefined
          ? decode(query.before, query)
          : query.after !== undefined
            ? decode(query.after, query)
            : undefined;
      const anchor =
        query.anchorExecutionId === undefined
          ? undefined
          : owned(
              await options.executions.getForRoot(
                query.anchorExecutionId,
                query.rootSessionId,
              ),
              query,
            );
      if (boundary && anchor && boundary.executionId !== anchor.executionId)
        throw invalidCursor();
      let record: SubagentExecutionRecord | undefined = boundary
        ? owned(
            await options.executions.getForRoot(
              boundary.executionId,
              query.rootSessionId,
            ),
            query,
          )
        : (anchor ??
          (
            await options.executions.list({
              rootSessionId: query.rootSessionId,
              subagentId: query.subagentId,
              limit: 1,
            })
          ).at(0));
      if (
        record === undefined ||
        record.rootSessionId !== query.rootSessionId ||
        record.subagentId !== query.subagentId
      )
        throw invalidCursor();
      if (
        boundary &&
        ((record.delegationSequence ?? 0) !== boundary.sequence ||
          (boundary.kind === "parent" &&
            record.childUserMessageId !== boundary.messageId) ||
          (boundary.kind === "message" &&
            (!record.childSessionId || !record.childScopeId)) ||
          (boundary.kind === "segment" &&
            boundary.messageId !== record.executionId))
      )
        throw invalidCursor();
      const forward =
        query.after !== undefined ||
        (anchor?.childUserMessageId !== undefined &&
          query.before === undefined);
      const items: HistoryItem[] = [];
      const records = new Map<string, SubagentExecutionRecord>();
      let position = boundary;
      let segmentCount = 0;
      let scanCursor: HistoryCursor | undefined;
      let truncatedScan = false;
      let lastSegment: SubagentExecutionRecord | undefined;
      if (position?.kind === "segment") {
        record = await adjacent(record, query, forward);
        position = undefined;
      }
      while (record && items.length <= limit && segmentCount++ <= limit + 1) {
        query.signal?.throwIfAborted();
        const currentRecord = record;
        lastSegment = currentRecord;
        records.set(record.executionId, record);
        const parentUi = await parent(record);
        const parentItem =
          parentUi && record.childUserMessageId
            ? {
                record,
                message: parentUi,
                cursor: cursorFor(
                  record,
                  {
                    id: parentUi.id,
                    time: { created: record.createdAt },
                  } as Message,
                  "parent",
                ),
              }
            : undefined;
        const pageLimit = Math.min(200, limit - items.length + 2);
        let pageCursor =
          position?.kind === "message" ? position.messageCursor : undefined;
        if (
          forward &&
          pageCursor === undefined &&
          parentItem &&
          record.childSessionId &&
          record.childRunId
        ) {
          const persisted = (
            await options.messages.listByIds(record.childSessionId, [
              parentItem.message.id,
            ])
          ).at(0);
          const anchorMessage =
            persisted !== undefined &&
            persisted.info.contextScopeId === record.childScopeId &&
            (persisted.info.runId === undefined ||
              persisted.info.runId === record.childRunId)
              ? persisted.info
              : ({
                  id: parentItem.message.id,
                  time: { created: record.createdAt },
                } as Message);
          pageCursor = messageCursor(
            record.childSessionId,
            anchorMessage,
            { scope: { contextScopeId: record.childScopeId } },
            record.childRunId,
          );
        }
        if (forward && parentItem && !position) items.push(parentItem);
        if (
          record.childSessionId &&
          record.childScopeId &&
          record.childRunId !== undefined &&
          !(position?.kind === "parent" && !forward)
        ) {
          let more = false;
          let rowsScanned = 0;
          for (;;) {
            if (items.length > limit) break;
            const pageOptions = {
              scope: { contextScopeId: record.childScopeId },
              limit: pageLimit,
              ...(forward ? { after: pageCursor } : { before: pageCursor }),
            };
            const page = await options.messages.listPageByRun(
              record.childSessionId,
              record.childRunId,
              pageOptions,
            );
            const visible = page.messages.filter(
              (entry) => entry.info.id !== currentRecord.childUserMessageId,
            );
            const scanned = forward ? page.messages.at(-1) : page.messages[0];
            if (scanned)
              scanCursor = cursorFor(currentRecord, scanned.info, "message");
            rowsScanned += page.messages.length;
            const mapped = visible.flatMap((entry) => {
              const message = options.project(entry);
              return message
                ? [
                    {
                      record: currentRecord,
                      message,
                      cursor: cursorFor(currentRecord, entry.info, "message"),
                    },
                  ]
                : [];
            });
            if (forward) items.push(...mapped);
            else items.push(...mapped.reverse());
            more = page.hasMore;
            pageCursor = page.nextCursor;
            if (!more || !pageCursor || rowsScanned >= 2 * (limit + 1)) break;
          }
          if (more) truncatedScan = true;
          if (more || items.length > limit) break;
        }
        if (!forward && parentItem && position?.kind !== "parent")
          items.push(parentItem);
        if (items.length > limit) break;
        record = await adjacent(record, query, forward);
        position = undefined;
      }
      const hasDirectionMore =
        items.length > limit ||
        truncatedScan ||
        (record !== undefined && segmentCount > limit + 1);
      const selected = items.slice(0, limit);
      if (!forward) selected.reverse();
      const first = selected.at(0);
      const last = selected.at(-1);
      const emptyPageCursor = truncatedScan
        ? scanCursor
        : hasDirectionMore && lastSegment
          ? segmentCursor(lastSegment)
          : scanCursor;
      return {
        messages: selected.map((item) => item.message),
        history: {
          before: first
            ? encode(first.cursor)
            : !forward && emptyPageCursor
              ? encode(emptyPageCursor)
              : undefined,
          after: last
            ? encode(last.cursor)
            : forward && emptyPageCursor
              ? encode(emptyPageCursor)
              : undefined,
          hasMore: forward
            ? query.after !== undefined ||
              (anchor !== undefined &&
                (await adjacent(anchor, query, false)) !== undefined)
            : hasDirectionMore,
          hasLater: forward ? hasDirectionMore : query.before !== undefined,
        },
        executions: [...records.values()],
        anchorMessageId: anchor?.childUserMessageId,
        anchorFound: anchor?.childUserMessageId !== undefined,
      };
    },
  };
}
