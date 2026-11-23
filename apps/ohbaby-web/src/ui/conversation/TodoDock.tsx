import { Check, ChevronDown } from "lucide-react";
import type { UiSessionTodoList, UiTodoStatus } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { Spinner } from "../shared/Spinner.js";

type TodoItem = UiSessionTodoList["todos"][number];

export function TodoDock(props: {
  readonly todoList: UiSessionTodoList | null;
}): ReactElement | null {
  const [expanded, setExpanded] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const firstActiveIndex =
    props.todoList?.todos.findIndex((todo) => todo.status === "in_progress") ??
    -1;

  // Keep the first task in progress in view, scrolling only the list itself and
  // only when that task changes, so a manual scroll is left alone.
  useLayoutEffect(() => {
    const list = listRef.current;
    const row =
      firstActiveIndex >= 0 ? list?.children[firstActiveIndex] : undefined;
    if (!list || !row) return;

    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < listRect.top) {
      list.scrollTop -= listRect.top - rowRect.top;
    } else if (rowRect.bottom > listRect.bottom) {
      list.scrollTop += rowRect.bottom - listRect.bottom;
    }
  }, [expanded, firstActiveIndex]);

  if (!props.todoList) {
    return null;
  }

  const todos = props.todoList.todos;
  const completedCount = todos.filter(
    (todo) => todo.status === "completed",
  ).length;
  const preview = selectTodoDockPreview(todos);
  const moreInProgress =
    preview?.status === "in_progress"
      ? todos.filter((todo) => todo.status === "in_progress").length - 1
      : 0;

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
            {String(completedCount)}/{String(todos.length)} completed
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
          ref={listRef}
          role="list"
          tabIndex={0}
        >
          {todos.map((todo, index) => (
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
          {preview ? (
            <TodoDockItem moreInProgress={moreInProgress} todo={preview} />
          ) : null}
        </div>
      )}
    </section>
  );
}

function TodoDockItem(props: {
  readonly todo: TodoItem;
  readonly moreInProgress?: number;
}): ReactElement {
  const more = props.moreInProgress ?? 0;
  const label = `${todoStatusLabel(props.todo.status)}: ${props.todo.content}`;
  return (
    <div
      aria-label={
        more > 0 ? `${label}, ${String(more)} more in progress` : label
      }
      className={`ohb-todo-item ohb-todo-${props.todo.status}`}
      role="listitem"
    >
      <span aria-hidden="true" className="ohb-todo-marker">
        <TodoStatusMarker status={props.todo.status} />
      </span>
      <span className="ohb-todo-text">{props.todo.content}</span>
      {more > 0 ? (
        <span aria-hidden="true" className="ohb-todo-more">
          +{String(more)}
        </span>
      ) : null}
    </div>
  );
}

function TodoStatusMarker(props: {
  readonly status: UiTodoStatus;
}): ReactElement {
  switch (props.status) {
    case "pending":
      return <span className="ohb-todo-ring" />;
    case "in_progress":
      return <Spinner size={11} />;
    case "completed":
      return <Check size={14} strokeWidth={1.6} />;
  }
}

function selectTodoDockPreview(
  todos: UiSessionTodoList["todos"],
): TodoItem | undefined {
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
