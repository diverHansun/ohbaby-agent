import { render } from "ink-testing-library";
import type { UiTodoItem } from "ohbaby-sdk";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "../theme/index.js";
import { selectCompactTodos, TodoPanel } from "./todo-panel.js";

describe("TodoPanel", () => {
  it("selects work in progress, then early pending, then recent completed", () => {
    const todos: readonly UiTodoItem[] = [
      { content: "completed old", status: "completed" },
      { content: "pending first", status: "pending" },
      { content: "running first", status: "in_progress" },
      { content: "pending second", status: "pending" },
      { content: "completed recent", status: "completed" },
      { content: "running second", status: "in_progress" },
      { content: "completed newest", status: "completed" },
    ];

    expect(selectCompactTodos(todos).map((todo) => todo.content)).toEqual([
      "pending first",
      "running first",
      "pending second",
      "running second",
      "completed newest",
    ]);
  });

  it("takes the first five in-progress items and preserves array order", () => {
    const todos: readonly UiTodoItem[] = [
      { content: "pending", status: "pending" },
      ...Array.from({ length: 6 }, (_, index) => ({
        content: `running ${String(index + 1)}`,
        status: "in_progress" as const,
      })),
    ];

    expect(selectCompactTodos(todos).map((todo) => todo.content)).toEqual([
      "running 1",
      "running 2",
      "running 3",
      "running 4",
      "running 5",
    ]);
  });

  it("shows complete counts and stopped status without changing unfinished markers", () => {
    const app = render(
      <ThemeProvider>
        <TodoPanel
          expanded
          stopped
          todoList={{
            sessionId: "s",
            visible: true,
            todos: [
              { content: "finished", status: "completed" },
              { content: "interrupted", status: "in_progress" },
            ],
          }}
        />
      </ThemeProvider>,
    );
    expect(app.lastFrame()).toContain("Tasks · Stopped 1/2 completed");
    expect(app.lastFrame()).toContain("● interrupted");
    app.unmount();
  });

  it("renders a one-line collapsed summary and all items when expanded", () => {
    const todos: readonly UiTodoItem[] = Array.from(
      { length: 10 },
      (_, index) => ({
        content: `task ${String(index + 1)}`,
        status: index === 0 ? "in_progress" : "pending",
      }),
    );
    const todoList = { sessionId: "session_1", todos, visible: true };
    const app = render(
      <ThemeProvider>
        <TodoPanel expanded={false} todoList={todoList} />
      </ThemeProvider>,
    );

    expect(app.lastFrame()).toContain("Tasks 0/10 completed · Ctrl+T expand");
    expect(app.lastFrame()).not.toContain("task 5");
    expect(app.lastFrame()).not.toContain("task 6");

    app.rerender(
      <ThemeProvider>
        <TodoPanel expanded todoList={todoList} />
      </ThemeProvider>,
    );
    expect(app.lastFrame()).toContain("task 10");
    expect(app.lastFrame()).toContain("ctrl+t to collapse");
  });
});
