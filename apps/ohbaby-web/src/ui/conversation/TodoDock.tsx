import { ChevronDown } from "lucide-react";
import type { UiSessionTodoList, UiTodoStatus } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useState } from "react";

export function TodoDock(props: {
  readonly todoList: UiSessionTodoList | null;
}): ReactElement | null {
  const [expanded, setExpanded] = useState(true);

  if (!props.todoList) {
    return null;
  }

  const completedCount = props.todoList.todos.filter(
    (todo) => todo.status === "completed",
  ).length;
  const preview = selectTodoDockPreview(props.todoList.todos);

  return (
    <section
      aria-label="Todo list"
      className={`ohb-todo-dock ${expanded ? "ohb-todo-dock-expanded" : "ohb-todo-dock-collapsed"}`}
    >
      <header>
        <button
          aria-controls="ohb-todo-items"
          aria-expanded={expanded}
          className="ohb-todo-toggle"
          onClick={() => {
            setExpanded((current) => !current);
          }}
          title={expanded ? "Collapse todo list" : "Expand todo list"}
          type="button"
        >
          <span className="ohb-todo-title">Tasks</span>
          <span className="ohb-todo-progress">
            {String(completedCount)}/{String(props.todoList.todos.length)}{" "}
            completed
          </span>
          <ChevronDown
            aria-hidden="true"
            className="ohb-todo-chevron"
            size={14}
          />
        </button>
      </header>
      {expanded ? (
        <div
          aria-label="Todo items"
          className="ohb-todo-items"
          id="ohb-todo-items"
          role="list"
          tabIndex={0}
        >
          {props.todoList.todos.map((todo, index) => (
            <TodoDockItem
              key={`${String(index)}:${todo.content}`}
              todo={todo}
            />
          ))}
        </div>
      ) : (
        <div
          aria-label="Current todo"
          className="ohb-todo-preview"
          id="ohb-todo-items"
          role="list"
        >
          {preview ? <TodoDockItem todo={preview} /> : null}
        </div>
      )}
    </section>
  );
}

function TodoDockItem(props: {
  readonly todo: NonNullable<UiSessionTodoList | null>["todos"][number];
}): ReactElement {
  return (
    <div
      aria-label={`${todoStatusLabel(props.todo.status)}: ${props.todo.content}`}
      className={`ohb-todo-item ohb-todo-${props.todo.status}`}
      role="listitem"
    >
      <span aria-hidden="true" className="ohb-todo-marker">
        {todoStatusMarker(props.todo.status)}
      </span>
      <span>{props.todo.content}</span>
    </div>
  );
}

function selectTodoDockPreview(
  todos: NonNullable<UiSessionTodoList | null>["todos"],
): NonNullable<UiSessionTodoList | null>["todos"][number] | undefined {
  return (
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "pending") ??
    todos.at(-1)
  );
}

function todoStatusLabel(status: UiTodoStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "in_progress":
      return "In progress";
    case "completed":
      return "Completed";
  }
}

function todoStatusMarker(status: UiTodoStatus): string {
  switch (status) {
    case "pending":
      return "○";
    case "in_progress":
      return "●";
    case "completed":
      return "✓";
  }
}
