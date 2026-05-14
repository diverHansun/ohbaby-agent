import type {
  Tool,
  ToolExecutionResult,
} from "../core/tool-scheduler/index.js";
import { ToolParameterError } from "./utils/params.js";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type TodoPriority = "high" | "medium" | "low";

export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
  readonly priority?: TodoPriority;
}

export interface TodoStore {
  read(sessionId: string): readonly TodoItem[];
  write(sessionId: string, todos: readonly TodoItem[]): void;
}

const TODO_STATUSES = new Set<TodoStatus>([
  "cancelled",
  "completed",
  "in_progress",
  "pending",
]);
const TODO_PRIORITIES = new Set<TodoPriority>(["high", "medium", "low"]);

export class InMemoryTodoStore implements TodoStore {
  private readonly bySession = new Map<string, readonly TodoItem[]>();

  read(sessionId: string): readonly TodoItem[] {
    return this.bySession.get(sessionId) ?? [];
  }

  write(sessionId: string, todos: readonly TodoItem[]): void {
    this.bySession.set(sessionId, todos.map((todo) => ({ ...todo })));
  }
}

function assertTodoStatus(value: unknown): asserts value is TodoStatus {
  if (typeof value !== "string" || !TODO_STATUSES.has(value as TodoStatus)) {
    throw new ToolParameterError(`Invalid todo status: ${String(value)}`);
  }
}

function assertTodoPriority(value: unknown): asserts value is TodoPriority {
  if (typeof value !== "string" || !TODO_PRIORITIES.has(value as TodoPriority)) {
    throw new ToolParameterError(`Invalid todo priority: ${String(value)}`);
  }
}

function parseTodos(params: Record<string, unknown>): readonly TodoItem[] {
  const value = params.todos;
  if (!Array.isArray(value)) {
    throw new ToolParameterError('Expected parameter "todos" to be an array.');
  }

  return value.map((item, index): TodoItem => {
    if (typeof item !== "object" || item === null) {
      throw new ToolParameterError(`Expected todo at index ${String(index)} to be an object.`);
    }
    const record = item as Record<string, unknown>;
    const { content, id, priority, status } = record;
    if (typeof id !== "string" || id.trim() === "") {
      throw new ToolParameterError(`Expected todo at index ${String(index)} to have an id.`);
    }
    if (typeof content !== "string" || content.trim() === "") {
      throw new ToolParameterError(
        `Expected todo at index ${String(index)} to have non-empty content.`,
      );
    }
    assertTodoStatus(status);
    if (priority !== undefined) {
      assertTodoPriority(priority);
    }

    return { content, id, priority, status };
  });
}

function renderTodos(todos: readonly TodoItem[]): string {
  if (todos.length === 0) {
    return "No todos.";
  }

  return todos
    .map((todo) => {
      const priority = todo.priority ?? "medium";
      return `[${todo.status}] (${priority}) ${todo.id}: ${todo.content}`;
    })
    .join("\n");
}

function createTodoReadTool(store: TodoStore): Tool {
  return {
    name: "todo_read",
    description: "Read the current session-scoped todo list.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {},
      type: "object",
    },
    source: "builtin",
    category: "memory",
    annotations: { readOnlyHint: true },
    execute(_params, context): ToolExecutionResult {
      const todos = store.read(context.sessionId);
      return {
        output: renderTodos(todos),
        metadata: { count: todos.length, todos },
      };
    },
  };
}

function createTodoWriteTool(store: TodoStore): Tool {
  return {
    name: "todo_write",
    description: "Replace the current session-scoped todo list.",
    parametersJsonSchema: {
      additionalProperties: false,
      properties: {
        todos: {
          items: {
            additionalProperties: false,
            properties: {
              content: { type: "string" },
              id: { type: "string" },
              priority: { enum: ["high", "medium", "low"], type: "string" },
              status: {
                enum: ["pending", "in_progress", "completed", "cancelled"],
                type: "string",
              },
            },
            required: ["id", "content", "status"],
            type: "object",
          },
          type: "array",
        },
      },
      required: ["todos"],
      type: "object",
    },
    source: "builtin",
    category: "memory",
    execute(params, context): ToolExecutionResult {
      const todos = parseTodos(params);
      store.write(context.sessionId, todos);
      return {
        output: renderTodos(todos),
        metadata: { count: todos.length, todos },
      };
    },
  };
}

export function createTodoTools(store: TodoStore = new InMemoryTodoStore()): Tool[] {
  return [createTodoReadTool(store), createTodoWriteTool(store)];
}
