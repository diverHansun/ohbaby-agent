import {
  getDatabase,
  runWithBusyRetry,
  schema,
  type DatabaseConnection,
} from "../../services/database/index.js";
import type {
  CreatePartInput,
  Message,
  MessageStore,
  MessageWithParts,
  Part,
  UpdateMessagePatch,
  UpdatePartPatch,
} from "./types.js";

interface MessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly role: Message["role"];
  readonly agent: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly data: string;
}

interface PartRow {
  readonly id: string;
  readonly message_id: string;
  readonly session_id: string;
  readonly type: Part["type"];
  readonly order_index: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly data: string;
}

interface DatabaseMessageStoreOptions {
  readonly db?: DatabaseConnection;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function messageTimestamps(message: Message): {
  readonly createdAt: number;
  readonly updatedAt: number;
} {
  return {
    createdAt: message.time.created,
    updatedAt: message.time.updated ?? message.time.created,
  };
}

function messageToRowData(message: Message): string {
  return JSON.stringify(message);
}

function partToRowData(part: Part): string {
  return JSON.stringify(part);
}

function rowToMessage(row: MessageRow): Message {
  return JSON.parse(row.data) as Message;
}

function rowToPart(row: PartRow): Part {
  return JSON.parse(row.data) as Part;
}

function messageAgent(message: Message): string | null {
  return "agent" in message ? (message.agent ?? null) : null;
}

export function createDatabaseMessageStore(
  options: DatabaseMessageStoreOptions = {},
): MessageStore {
  const db = options.db ?? getDatabase();

  async function withAsyncBoundary<T>(operation: () => T): Promise<T> {
    await Promise.resolve();
    return operation();
  }

  function withImmediateTransaction<T>(operation: () => T): T {
    runWithBusyRetry(() => {
      db.exec("BEGIN IMMEDIATE");
    });
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original store error.
      }
      throw error;
    }
  }

  function touchMessage(messageId: string, updatedAt: number): void {
    const existing = getMessageRow(messageId);
    if (!existing) {
      return;
    }
    const message = rowToMessage(existing);
    const updated = {
      ...message,
      time: {
        ...message.time,
        updated: updatedAt,
      },
    } as Message;
    updateMessageRow(updated);
  }

  function updateMessageRow(message: Message): void {
    const timestamps = messageTimestamps(message);
    db.prepare(
      `UPDATE ${schema.message.tableName}
       SET role = ?, agent = ?, created_at = ?, updated_at = ?, data = ?
       WHERE id = ?`,
    ).run(
      message.role,
      messageAgent(message),
      timestamps.createdAt,
      timestamps.updatedAt,
      messageToRowData(message),
      message.id,
    );
  }

  function getMessageRow(messageId: string): MessageRow | undefined {
    return db
      .prepare<MessageRow>(
        `SELECT * FROM ${schema.message.tableName} WHERE id = ?`,
      )
      .get(messageId);
  }

  function nextOrderIndex(messageId: string): number {
    const row = db
      .prepare<{ next_index: number | null }>(
        `SELECT COALESCE(MAX(order_index) + 1, 0) AS next_index
         FROM ${schema.part.tableName}
         WHERE message_id = ?`,
      )
      .get(messageId);
    return row?.next_index ?? 0;
  }

  return {
    insertMessage(message: Message): Promise<void> {
      return withAsyncBoundary(() => {
        const timestamps = messageTimestamps(message);
        db.prepare(
          `INSERT INTO ${schema.message.tableName}
            (id, session_id, role, agent, created_at, updated_at, data)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          message.id,
          message.sessionId,
          message.role,
          messageAgent(message),
          timestamps.createdAt,
          timestamps.updatedAt,
          messageToRowData(message),
        );
      });
    },

    getMessage(messageId: string): Promise<Message | undefined> {
      return withAsyncBoundary(() => {
        const row = getMessageRow(messageId);
        return row ? clone(rowToMessage(row)) : undefined;
      });
    },

    updateMessage(
      messageId: string,
      patch: UpdateMessagePatch,
    ): Promise<Message> {
      return withAsyncBoundary(() => {
        const row = getMessageRow(messageId);
        if (!row) {
          throw new Error(`Message not found: ${messageId}`);
        }
        const updated = { ...rowToMessage(row), ...patch } as Message;
        updateMessageRow(updated);
        return clone(updated);
      });
    },

    appendPart(input: {
      readonly message: Message;
      readonly partId: string;
      readonly data: CreatePartInput;
      readonly updatedAt: number;
    }): Promise<Part> {
      return withAsyncBoundary(() =>
        withImmediateTransaction(() => {
          const row = getMessageRow(input.message.id);
          if (!row) {
            throw new Error(`Message not found: ${input.message.id}`);
          }
          const part = {
            id: input.partId,
            messageId: input.message.id,
            sessionId: input.message.sessionId,
            orderIndex: nextOrderIndex(input.message.id),
            ...input.data,
          } as Part;
          db.prepare(
            `INSERT INTO ${schema.part.tableName}
            (id, message_id, session_id, type, order_index, created_at, updated_at, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            part.id,
            part.messageId,
            part.sessionId,
            part.type,
            part.orderIndex,
            input.updatedAt,
            input.updatedAt,
            partToRowData(part),
          );
          touchMessage(input.message.id, input.updatedAt);
          return clone(part);
        }),
      );
    },

    updatePart(
      partId: string,
      patch: Omit<UpdatePartPatch, "delta">,
      updatedAt: number,
    ): Promise<Part> {
      return withAsyncBoundary(() =>
        withImmediateTransaction(() => {
          const row = db
            .prepare<PartRow>(
              `SELECT * FROM ${schema.part.tableName} WHERE id = ?`,
            )
            .get(partId);
          if (!row) {
            throw new Error(`Part not found: ${partId}`);
          }
          const updated = { ...rowToPart(row), ...patch } as Part;
          db.prepare(
            `UPDATE ${schema.part.tableName}
           SET type = ?, order_index = ?, updated_at = ?, data = ?
           WHERE id = ?`,
          ).run(
            updated.type,
            updated.orderIndex,
            updatedAt,
            partToRowData(updated),
            partId,
          );
          touchMessage(updated.messageId, updatedAt);
          return clone(updated);
        }),
      );
    },

    listBySession(sessionId: string): Promise<MessageWithParts[]> {
      return withAsyncBoundary(() => {
        const messageRows = db
          .prepare<MessageRow>(
            `SELECT * FROM ${schema.message.tableName}
              WHERE session_id = ?
              ORDER BY created_at ASC, rowid ASC`,
          )
          .all(sessionId);
        return messageRows.map((messageRow) => {
          const parts = db
            .prepare<PartRow>(
              `SELECT * FROM ${schema.part.tableName}
               WHERE message_id = ?
               ORDER BY order_index ASC`,
            )
            .all(messageRow.id)
            .map(rowToPart)
            .map(clone);
          return {
            info: clone(rowToMessage(messageRow)),
            parts,
          };
        });
      });
    },

    deleteMessage(messageId: string): Promise<void> {
      return withAsyncBoundary(() => {
        db.prepare(`DELETE FROM ${schema.message.tableName} WHERE id = ?`).run(
          messageId,
        );
      });
    },

    deleteBySession(sessionId: string): Promise<void> {
      return withAsyncBoundary(() => {
        db.prepare(
          `DELETE FROM ${schema.message.tableName} WHERE session_id = ?`,
        ).run(sessionId);
      });
    },
  };
}
