// @vitest-environment jsdom
import type { UiSessionTodoList } from "ohbaby-sdk";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodoDock } from "./TodoDock.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Status = UiSessionTodoList["todos"][number]["status"];

function todoList(...statuses: Status[]): UiSessionTodoList {
  return {
    sessionId: "session_1",
    todos: statuses.map((status, index) => ({
      content: `task ${String(index + 1)}`,
      status,
    })),
    visible: true,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(list: UiSessionTodoList | null): void {
  act(() => {
    root.render(<TodoDock todoList={list} />);
  });
}

function collapse(): void {
  const toggle = container.querySelector<HTMLButtonElement>(".ohb-todo-toggle");
  act(() => {
    toggle?.click();
  });
}

function preview(): HTMLElement | null {
  return container.querySelector(".ohb-todo-preview .ohb-todo-item");
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

describe("TodoDock status markers", () => {
  it("marks each status with an element and keeps the text to the task", () => {
    render(todoList("completed", "in_progress", "pending"));
    const rows = Array.from(container.querySelectorAll(".ohb-todo-item"));

    expect(rows.map((row) => row.textContent)).toEqual([
      "task 1",
      "task 2",
      "task 3",
    ]);
    expect(rows[0].querySelector(".ohb-todo-marker svg")).not.toBeNull();
    expect(
      rows[1].querySelector(".ohb-todo-marker .ohb-spinner"),
    ).not.toBeNull();
    expect(
      rows[2].querySelector(".ohb-todo-marker .ohb-todo-ring"),
    ).not.toBeNull();
    expect(container.textContent).not.toMatch(/[○●✓]/u);
  });
});

describe("TodoDock collapsed summary", () => {
  it("shows the first task in progress and counts the others apart", () => {
    render(todoList("completed", "in_progress", "pending", "in_progress"));
    collapse();

    expect(preview()?.querySelector(".ohb-todo-text")?.textContent).toBe(
      "task 2",
    );
    expect(preview()?.querySelector(".ohb-todo-more")?.textContent).toBe("+1");
    expect(preview()?.getAttribute("aria-label")).toBe(
      "In progress: task 2, 1 more in progress",
    );
  });

  it("shows no count for a single task in progress", () => {
    render(todoList("completed", "in_progress", "pending"));
    collapse();

    expect(preview()?.textContent).toBe("task 2");
    expect(preview()?.querySelector(".ohb-todo-more")).toBeNull();
  });

  it("falls back to the first pending task, then the last task, without a count", () => {
    render(todoList("completed", "pending", "pending"));
    collapse();
    expect(preview()?.textContent).toBe("task 2");

    render(todoList("completed", "completed"));
    expect(preview()?.textContent).toBe("task 2");
    expect(container.querySelector(".ohb-todo-more")).toBeNull();
  });
});

describe("TodoDock follows the task in progress", () => {
  // jsdom has no layout: each row is 20px tall and the list shows 60px.
  function stubLayout(): void {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const list = this.closest(".ohb-todo-items");
        const scrollTop = list?.scrollTop ?? 0;
        if (this === list) return new DOMRect(0, 0, 300, 60);
        const index = list ? Array.from(list.children).indexOf(this) : -1;
        return new DOMRect(0, index * 20 - scrollTop, 300, 20);
      },
    );
  }

  function list(): HTMLElement {
    const element = container.querySelector<HTMLElement>(".ohb-todo-items");
    if (!element) throw new Error("missing todo list");
    return element;
  }

  it("scrolls the list when the first task in progress moves out of view", () => {
    stubLayout();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    render(todoList("in_progress", "pending", "pending", "pending", "pending"));
    expect(list().scrollTop).toBe(0);

    render(
      todoList("completed", "completed", "completed", "in_progress", "pending"),
    );
    expect(list().scrollTop).toBe(20);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(0);
    expect(document.documentElement.scrollTop).toBe(0);
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  it("leaves a manual scroll alone while the first task in progress stays put", () => {
    stubLayout();
    render(todoList("pending", "pending", "pending", "in_progress", "pending"));
    list().scrollTop = 40;

    render(
      todoList("pending", "completed", "pending", "in_progress", "in_progress"),
    );
    expect(list().scrollTop).toBe(40);
  });
});

describe("TodoDock mounting", () => {
  it("survives the list disappearing and coming back on the same instance", () => {
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(null);
    render(todoList("in_progress"));
    render(null);
    render(todoList("pending", "in_progress"));

    expect(container.querySelectorAll(".ohb-todo-item")).toHaveLength(2);
    expect(errors).not.toHaveBeenCalled();
  });
});
