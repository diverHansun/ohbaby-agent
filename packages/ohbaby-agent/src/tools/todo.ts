import type { MessageWithParts } from "../core/message/index.js";
import type { MessageScopeFilter } from "../core/message/types.js";
import type {
  Tool,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { ToolParameterError } from "./utils/params.js";

export const MAX_TODO_ITEMS = 10;
export const MAX_TODO_CONTENT_LENGTH = 100;

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoWorkScopeId = `goal:${string}`;

export function goalTodoWorkScopeId(goalId: string): TodoWorkScopeId {
  const normalized = goalId.trim();
  if (normalized === "") {
    throw new Error("Goal-owned Todo scope requires a non-empty goalId.");
  }
  return `goal:${normalized}`;
}

export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
}

export interface TodoWriteResult {
  readonly changed: boolean;
  readonly todos: readonly TodoItem[];
}

export interface TodoStore {
  read(
    sessionId: string,
    contextScopeId?: string,
    workScopeId?: TodoWorkScopeId,
  ): Promise<readonly TodoItem[]> | readonly TodoItem[];
  write(
    sessionId: string,
    todos: readonly TodoItem[],
    contextScopeId?: string,
    workScopeId?: TodoWorkScopeId,
  ): Promise<TodoWriteResult> | TodoWriteResult;
}

export interface TodoWriteEvent extends TodoWriteResult {
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly workScopeId?: TodoWorkScopeId;
}

export interface TodoWorkScopeLease {
  readonly workScopeId?: TodoWorkScopeId;
  release(): void;
}

export class TodoWorkScopeRegistry {
  private readonly activeBySession = new Map<
    string,
    { readonly token: object; readonly workScopeId?: TodoWorkScopeId }
  >();

  acquire(
    sessionId: string,
    workScopeId?: TodoWorkScopeId,
  ): TodoWorkScopeLease {
    const token = {};
    this.activeBySession.set(sessionId, {
      token,
      ...(workScopeId === undefined ? {} : { workScopeId }),
    });
    let released = false;
    return {
      ...(workScopeId === undefined ? {} : { workScopeId }),
      release: (): void => {
        if (released) return;
        released = true;
        if (this.activeBySession.get(sessionId)?.token === token) {
          this.activeBySession.delete(sessionId);
        }
      },
    };
  }

  resolve(sessionId: string): TodoWorkScopeId | undefined {
    return this.activeBySession.get(sessionId)?.workScopeId;
  }

  release(sessionId: string): void {
    this.activeBySession.delete(sessionId);
  }

  dispose(): void {
    this.activeBySession.clear();
  }
}

export interface TodoToolOptions {
  readonly resolveWorkScopeId?: (
    context: ToolExecutionContext,
  ) => TodoWorkScopeId | undefined;
}

export interface TodoHistorySource {
  listBySession(
    sessionId: string,
    options?: MessageScopeFilter,
  ): Promise<readonly MessageWithParts[]>;
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
const TODO_WORK_SCOPE_METADATA_KEY = "internalWorkScopeId";

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function todoScopeKey(input: {
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly workScopeId?: TodoWorkScopeId;
}): string {
  const contextScopeId =
    input.contextScopeId === undefined
      ? "-"
      : encodeKeyPart(input.contextScopeId);
  const workScopeId =
    input.contextScopeId !== undefined || input.workScopeId === undefined
      ? "-"
      : encodeKeyPart(input.workScopeId);
  return `todo:${encodeKeyPart(input.sessionId)}::context:${contextScopeId}::work:${workScopeId}`;
}

function todoSessionKeyPrefix(sessionId: string): string {
  return `todo:${encodeKeyPart(sessionId)}::`;
}

function effectiveWorkScopeId(
  contextScopeId: string | undefined,
  workScopeId: TodoWorkScopeId | undefined,
): TodoWorkScopeId | undefined {
  return contextScopeId === undefined ? workScopeId : undefined;
}

export class TodoService implements TodoStore {
  private readonly loadedBySession = new Map<string, readonly TodoItem[]>();
  private readonly loadingBySession = new Map<
    string,
    {
      readonly promise: Promise<readonly TodoItem[]>;
      readonly token: object;
    }
  >();
  private readonly cancelledLoads = new WeakSet<object>();

  constructor(private readonly options: TodoServiceOptions = {}) {}

  async read(
    sessionId: string,
    contextScopeId?: string,
    workScopeId?: TodoWorkScopeId,
  ): Promise<readonly TodoItem[]> {
    const effectiveWorkScope = effectiveWorkScopeId(
      contextScopeId,
      workScopeId,
    );
    const key = todoScopeKey({
      contextScopeId,
      sessionId,
      workScopeId: effectiveWorkScope,
    });
    const loaded = this.loadedBySession.get(key);
    if (loaded !== undefined) {
      return cloneTodos(loaded);
    }

    let loading = this.loadingBySession.get(key);
    if (loading === undefined) {
      const token = {};
      loading = {
        promise: this.loadFromHistory(
          sessionId,
          contextScopeId,
          effectiveWorkScope,
          token,
        ),
        token,
      };
      this.loadingBySession.set(key, loading);
    }

    try {
      return cloneTodos(await loading.promise);
    } finally {
      if (this.loadingBySession.get(key) === loading) {
        this.loadingBySession.delete(key);
      }
    }
  }

  write(
    sessionId: string,
    todos: readonly TodoItem[],
    contextScopeId?: string,
    workScopeId?: TodoWorkScopeId,
  ): TodoWriteResult {
    const effectiveWorkScope = effectiveWorkScopeId(
      contextScopeId,
      workScopeId,
    );
    const key = todoScopeKey({
      contextScopeId,
      sessionId,
      workScopeId: effectiveWorkScope,
    });
    const next = cloneTodos(todos);
    const previous = this.loadedBySession.get(key);
    const changed = previous === undefined || !todosEqual(previous, next);
    this.loadedBySession.set(key, next);

    const result = { changed, todos: cloneTodos(next) };
    this.options.onWrite?.({
      ...result,
      ...(contextScopeId === undefined ? {} : { contextScopeId }),
      sessionId,
      ...(effectiveWorkScope === undefined
        ? {}
        : { workScopeId: effectiveWorkScope }),
    });
    return result;
  }

  release(sessionId: string): void {
    const prefix = todoSessionKeyPrefix(sessionId);
    for (const [key, loading] of this.loadingBySession) {
      if (key.startsWith(prefix)) {
        this.cancelledLoads.add(loading.token);
        this.loadingBySession.delete(key);
      }
    }
    for (const key of this.loadedBySession.keys()) {
      if (key.startsWith(prefix)) {
        this.loadedBySession.delete(key);
      }
    }
  }

  releaseScope(
    sessionId: string,
    contextScopeId?: string,
    workScopeId?: TodoWorkScopeId,
  ): void {
    const key = todoScopeKey({
      contextScopeId,
      sessionId,
      workScopeId: effectiveWorkScopeId(contextScopeId, workScopeId),
    });
    const loading = this.loadingBySession.get(key);
    if (loading) {
      this.cancelledLoads.add(loading.token);
      this.loadingBySession.delete(key);
    }
    this.loadedBySession.delete(key);
  }

  dispose(): void {
    for (const loading of this.loadingBySession.values()) {
      this.cancelledLoads.add(loading.token);
    }
    this.loadedBySession.clear();
    this.loadingBySession.clear();
  }

  private async loadFromHistory(
    sessionId: string,
    contextScopeId: string | undefined,
    workScopeId: TodoWorkScopeId | undefined,
    token: object,
  ): Promise<readonly TodoItem[]> {
    const key = todoScopeKey({ contextScopeId, sessionId, workScopeId });
    let todos: readonly TodoItem[] = [];
    if (this.options.history) {
      try {
        const messages = await this.options.history.listBySession(
          sessionId,
          contextScopeId === undefined ? undefined : { contextScopeId },
        );
        todos = recoverTodosFromMessages(
          contextScopeId === undefined
            ? messages.filter(
                (message) => message.info.contextScopeId === undefined,
              )
            : messages,
          this.options.onWarning,
          workScopeId,
        );
      } catch (error) {
        this.options.onWarning?.(
          `Todo history could not be loaded for session ${sessionId}`,
          error,
        );
      }
    }

    if (this.cancelledLoads.has(token)) {
      return [];
    }
    const existing = this.loadedBySession.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const recovered = cloneTodos(todos);
    this.loadedBySession.set(key, recovered);
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
  workScopeId?: TodoWorkScopeId,
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
        const recoveredWorkScopeId = todoWorkScopeIdFromMetadata(
          part.state.metadata,
        );
        if (recoveredWorkScopeId !== workScopeId) {
          continue;
        }
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

function todoWorkScopeIdFromMetadata(
  metadata: Record<string, unknown> | undefined,
): TodoWorkScopeId | undefined {
  const value = metadata?.[TODO_WORK_SCOPE_METADATA_KEY];
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !value.startsWith("goal:") ||
    value.length === "goal:".length
  ) {
    throw new Error("Invalid Todo workload scope metadata.");
  }
  return value as TodoWorkScopeId;
}

function renderTodos(todos: readonly TodoItem[]): string {
  if (todos.length === 0) {
    return "No todos.";
  }
  return todos.map((todo) => `[${todo.status}] ${todo.content}`).join("\n");
}

function todoMetadata(
  todos: readonly TodoItem[],
  workScopeId?: TodoWorkScopeId,
): Record<string, unknown> {
  return {
    count: todos.length,
    todos: cloneTodos(todos),
    ...(workScopeId === undefined
      ? {}
      : { [TODO_WORK_SCOPE_METADATA_KEY]: workScopeId }),
  };
}

function resolveToolWorkScopeId(
  context: ToolExecutionContext,
  options: TodoToolOptions,
): TodoWorkScopeId | undefined {
  if (context.contextScopeId !== undefined) return undefined;
  return options.resolveWorkScopeId?.(context);
}

function createTodoReadTool(store: TodoStore, options: TodoToolOptions): Tool {
  return {
    name: "todo_read",
    description: "Read the todo list for the current task.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {},
      type: "object",
    },
    source: "builtin",
    category: "readonly",
    annotations: { readOnlyHint: true },
    async execute(_params, context): Promise<ToolExecutionResult> {
      const workScopeId = resolveToolWorkScopeId(context, options);
      const todos = await store.read(
        context.sessionId,
        context.contextScopeId,
        workScopeId,
      );
      return {
        output: renderTodos(todos),
        metadata: todoMetadata(todos, workScopeId),
      };
    },
  };
}

function createTodoWriteTool(store: TodoStore, options: TodoToolOptions): Tool {
  return {
    name: "todo_write",
    description:
      "Replace the todo list for the current task with a complete ordered list. Maximum 10 items; an empty list clears it.",
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
      const workScopeId = resolveToolWorkScopeId(context, options);
      const result = await store.write(
        context.sessionId,
        todos,
        context.contextScopeId,
        workScopeId,
      );
      return {
        output: renderTodos(result.todos),
        metadata: todoMetadata(result.todos, workScopeId),
      };
    },
  };
}

export function createTodoTools(
  store: TodoStore = new InMemoryTodoStore(),
  options: TodoToolOptions = {},
): Tool[] {
  return [
    createTodoReadTool(store, options),
    createTodoWriteTool(store, options),
  ];
}
