import type { MessageWithParts } from "../core/message/index.js";
import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { ToolParameterError } from "./utils/params.js";

export const MAX_TODO_ITEMS = 10;
export const MAX_TODO_CONTENT_LENGTH = 100;

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
}

export interface TodoWriteResult {
  readonly changed: boolean;
  readonly todos: readonly TodoItem[];
}

export interface TodoStore {
  read(sessionId: string): Promise<readonly TodoItem[]> | readonly TodoItem[];
  write(
    sessionId: string,
    todos: readonly TodoItem[],
  ): Promise<TodoWriteResult> | TodoWriteResult;
}

export interface TodoWriteEvent extends TodoWriteResult {
  readonly sessionId: string;
}

export interface TodoHistorySource {
  listBySession(sessionId: string): Promise<readonly MessageWithParts[]>;
}

export interface TodoServiceOptions {
  readonly history?: TodoHistorySource;
  readonly onWarning?: (message: string, error?: unknown) => void;
  readonly onWrite?: (event: TodoWriteEvent) => void;
}

const TODO_STATUSES = new Set<TodoStatus>([
  "completed",
  "in_progress",
  "pending",
]);
const TODO_ITEM_FIELDS = new Set(["content", "status"]);

export class TodoService implements TodoStore {
  private readonly loadedBySession = new Map<string, readonly TodoItem[]>();
  private readonly loadingBySession = new Map<
    string,
    Promise<readonly TodoItem[]>
  >();

  constructor(private readonly options: TodoServiceOptions = {}) {}

  async read(sessionId: string): Promise<readonly TodoItem[]> {
    const loaded = this.loadedBySession.get(sessionId);
    if (loaded !== undefined) {
      return cloneTodos(loaded);
    }

    let loading = this.loadingBySession.get(sessionId);
    if (loading === undefined) {
      loading = this.loadFromHistory(sessionId);
      this.loadingBySession.set(sessionId, loading);
    }

    try {
      return cloneTodos(await loading);
    } finally {
      if (this.loadingBySession.get(sessionId) === loading) {
        this.loadingBySession.delete(sessionId);
      }
    }
  }

  write(sessionId: string, todos: readonly TodoItem[]): TodoWriteResult {
    const next = cloneTodos(todos);
    const previous = this.loadedBySession.get(sessionId);
    const changed = previous === undefined || !todosEqual(previous, next);
    this.loadedBySession.set(sessionId, next);

    const result = { changed, todos: cloneTodos(next) };
    this.options.onWrite?.({ ...result, sessionId });
    return result;
  }

  release(sessionId: string): void {
    this.loadedBySession.delete(sessionId);
    this.loadingBySession.delete(sessionId);
  }

  dispose(): void {
    this.loadedBySession.clear();
    this.loadingBySession.clear();
  }

  private async loadFromHistory(
    sessionId: string,
  ): Promise<readonly TodoItem[]> {
    let todos: readonly TodoItem[] = [];
    if (this.options.history) {
      try {
        todos = recoverTodosFromMessages(
          await this.options.history.listBySession(sessionId),
          this.options.onWarning,
        );
      } catch (error) {
        this.options.onWarning?.(
          `Todo history could not be loaded for session ${sessionId}`,
          error,
        );
      }
    }

    const existing = this.loadedBySession.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const recovered = cloneTodos(todos);
    this.loadedBySession.set(sessionId, recovered);
    return recovered;
  }
}

export class InMemoryTodoStore extends TodoService {}

function cloneTodos(todos: readonly TodoItem[]): readonly TodoItem[] {
  return todos.map((todo) => ({ ...todo }));
}

function todosEqual(
  left: readonly TodoItem[],
  right: readonly TodoItem[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (todo, index) =>
        todo.content === right[index]?.content &&
        todo.status === right[index]?.status,
    )
  );
}

function assertTodoStatus(value: unknown): asserts value is TodoStatus {
  if (typeof value !== "string" || !TODO_STATUSES.has(value as TodoStatus)) {
    throw new ToolParameterError(`Invalid todo status: ${String(value)}`);
  }
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function parseTodoItem(value: unknown, index: number): TodoItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolParameterError(
      `Expected todo at index ${String(index)} to be an object.`,
    );
  }
  const record = value as Record<string, unknown>;
  const extraField = Object.keys(record).find(
    (field) => !TODO_ITEM_FIELDS.has(field),
  );
  if (extraField !== undefined) {
    throw new ToolParameterError(
      `Unexpected field "${extraField}" in todo at index ${String(index)}.`,
    );
  }

  const content =
    typeof record.content === "string" ? record.content.trim() : "";
  if (content === "") {
    throw new ToolParameterError(
      `Expected todo at index ${String(index)} to have non-empty content.`,
    );
  }
  if (unicodeLength(content) > MAX_TODO_CONTENT_LENGTH) {
    throw new ToolParameterError(
      `Todo content at index ${String(index)} exceeds ${String(MAX_TODO_CONTENT_LENGTH)} Unicode characters.`,
    );
  }
  assertTodoStatus(record.status);

  return { content, status: record.status };
}

function parseTodoArray(value: unknown): readonly TodoItem[] {
  if (!Array.isArray(value)) {
    throw new ToolParameterError('Expected parameter "todos" to be an array.');
  }
  if (value.length > MAX_TODO_ITEMS) {
    throw new ToolParameterError(
      `Todo list exceeds the maximum of ${String(MAX_TODO_ITEMS)} items.`,
    );
  }
  return value.map(parseTodoItem);
}

function parseTodos(params: Record<string, unknown>): readonly TodoItem[] {
  const extraField = Object.keys(params).find((field) => field !== "todos");
  if (extraField !== undefined) {
    throw new ToolParameterError(`Unexpected parameter "${extraField}".`);
  }
  return parseTodoArray(params.todos);
}

export function recoverTodosFromMessages(
  messages: readonly MessageWithParts[],
  onWarning?: (message: string, error?: unknown) => void,
): readonly TodoItem[] {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex];
    for (
      let partIndex = message.parts.length - 1;
      partIndex >= 0;
      partIndex -= 1
    ) {
      const part = message.parts[partIndex];
      if (
        part.type !== "tool" ||
        part.tool !== "todo_write" ||
        part.state.status !== "completed"
      ) {
        continue;
      }
      try {
        return parseTodos(part.state.input);
      } catch (error) {
        onWarning?.(
          `Ignoring invalid completed todo_write call ${part.callId} during recovery`,
          error,
        );
      }
    }
  }
  return [];
}

function renderTodos(todos: readonly TodoItem[]): string {
  if (todos.length === 0) {
    return "No todos.";
  }
  return todos.map((todo) => `[${todo.status}] ${todo.content}`).join("\n");
}

function todoMetadata(todos: readonly TodoItem[]): Record<string, unknown> {
  return { count: todos.length, todos: cloneTodos(todos) };
}

function createTodoReadTool(store: TodoStore): Tool {
  return {
    name: "todo_read",
    description:
      "Read the current session-scoped todo list. Todo lists are isolated per primary or child session.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {},
      type: "object",
    },
    source: "builtin",
    category: "readonly",
    annotations: { readOnlyHint: true },
    async execute(_params, context): Promise<ToolExecutionResult> {
      const todos = await store.read(context.sessionId);
      return { output: renderTodos(todos), metadata: todoMetadata(todos) };
    },
  };
}

function createTodoWriteTool(store: TodoStore): Tool {
  return {
    name: "todo_write",
    description:
      "Create or replace the current session-scoped todo list for complex, multi-step work. Keep at most 10 concise items in execution order, update statuses promptly, and use an empty list to clear it.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        todos: {
          items: {
            additionalProperties: false,
            properties: {
              content: {
                description:
                  "Concise task content, at most 100 Unicode characters.",
                type: "string",
              },
              status: {
                enum: ["pending", "in_progress", "completed"],
                type: "string",
              },
            },
            required: ["content", "status"],
            type: "object",
          },
          maxItems: MAX_TODO_ITEMS,
          type: "array",
        },
      },
      required: ["todos"],
      type: "object",
    },
    source: "builtin",
    category: "write",
    async execute(params, context): Promise<ToolExecutionResult> {
      const todos = parseTodos(params);
      const result = await store.write(context.sessionId, todos);
      return {
        output: renderTodos(result.todos),
        metadata: todoMetadata(result.todos),
      };
    },
  };
}

export function createTodoTools(
  store: TodoStore = new InMemoryTodoStore(),
): Tool[] {
  return [createTodoReadTool(store), createTodoWriteTool(store)];
}
