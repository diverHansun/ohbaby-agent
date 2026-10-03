import { Box, Text, useBoxMetrics, useInput, type DOMElement } from "ink";
import type { UiSessionTodoList, UiTodoItem, UiTodoStatus } from "ohbaby-sdk";
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { TodoPanelRefContext, useTuiLayout } from "../layout/context.js";
import { useTheme } from "../theme/index.js";

export const COMPACT_TODO_LIMIT = 5;

export interface TodoPanelProps {
  readonly expanded: boolean;
  readonly inputEnabled?: boolean;
  readonly todoList: UiSessionTodoList | null;
  readonly summaryOnly?: boolean;
  readonly stopped?: boolean;
}

export function TodoPanel({
  expanded,
  inputEnabled = true,
  todoList,
  summaryOnly = false,
  stopped = false,
}: TodoPanelProps): ReactElement | null {
  const theme = useTheme();
  const panelRef = useContext(TodoPanelRefContext);
  const contentRef = useRef<DOMElement>(null);
  const content = useBoxMetrics(contentRef);
  const layout = useTuiLayout();
  const [offset, setOffset] = useState(0);
  const budget = layout.todoPanelRows;
  const todos = todoList?.todos ?? [];
  const displayed = expanded ? todos : selectCompactTodos(todos);
  const hiddenCount = todos.length - displayed.length;
  const chromeRows = 1 + (hiddenCount > 0 ? 1 : 0);
  const paging =
    Boolean(todoList?.visible) &&
    todos.length > 0 &&
    !summaryOnly &&
    budget !== undefined &&
    content.height + chromeRows > budget;
  const pageRows = Math.max(
    1,
    (budget ?? content.height + chromeRows + 1) - chromeRows - 1,
  );
  const lastOffset = Math.max(0, content.height - pageRows);
  const start = Math.min(offset, lastOffset);
  useEffect(() => {
    setOffset(0);
  }, [expanded, todoList?.sessionId]);
  useInput(
    (_value, key) => {
      if (!key.meta || (!key.pageUp && !key.pageDown)) return;
      setOffset(
        Math.max(
          0,
          Math.min(lastOffset, start + (key.pageDown ? pageRows : -pageRows)),
        ),
      );
    },
    { isActive: paging && inputEnabled },
  );
  if (!todoList || todoList.todos.length === 0 || !todoList.visible) {
    return null;
  }

  // In a short terminal, keep approval choices and the saved draft in view.
  // The expanded state is retained and restored when the dialog closes.
  const completed = todos.filter((todo) => todo.status === "completed").length;
  if (summaryOnly || !expanded) {
    return (
      <Box ref={panelRef}>
        <Text color={theme.text.dim}>
          Tasks {completed}/{todos.length} completed · Ctrl+T expand
        </Text>
      </Box>
    );
  }

  return (
    <Box ref={panelRef} flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.status.accent}>
          Tasks{stopped ? " · Stopped" : ""} {completed}/{todos.length}{" "}
          completed
        </Text>
        {todos.length > 0 ? <Text dimColor>ctrl+t to collapse</Text> : null}
      </Box>
      <Box
        flexDirection="column"
        height={paging ? pageRows : undefined}
        overflow={paging ? "hidden" : undefined}
        contentOffsetY={paging ? start : 0}
      >
        <Box ref={contentRef} flexShrink={0} flexDirection="column">
          {displayed.map((todo, index) => (
            <Box key={`${String(index)}:${todo.content}`}>
              <Text color={todoColor(todo.status, theme)}>
                {todoMarker(todo.status)}{" "}
              </Text>
              <Text
                bold={!stopped && todo.status === "in_progress"}
                dimColor={todo.status === "completed"}
              >
                {todo.content}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
      {paging ? (
        <Text dimColor wrap="truncate-end">
          {start + 1}–{Math.min(start + pageRows, content.height)}/
          {content.height} rows · Alt+PgUp/PgDn
        </Text>
      ) : null}
      {hiddenCount > 0 ? (
        <Text dimColor>+{hiddenCount} more · ctrl+t to expand</Text>
      ) : null}
    </Box>
  );
}

export function selectCompactTodos(
  todos: readonly UiTodoItem[],
): readonly UiTodoItem[] {
  if (todos.length <= COMPACT_TODO_LIMIT) {
    return todos;
  }

  const selectedIndexes = new Set<number>();
  addMatchingIndexes(todos, selectedIndexes, "in_progress", false);
  addMatchingIndexes(todos, selectedIndexes, "pending", false);
  addMatchingIndexes(todos, selectedIndexes, "completed", true);

  return Array.from(selectedIndexes)
    .sort((left, right) => left - right)
    .map((index) => todos[index]);
}

function addMatchingIndexes(
  todos: readonly UiTodoItem[],
  selected: Set<number>,
  status: UiTodoStatus,
  reverse: boolean,
): void {
  for (
    let offset = 0;
    offset < todos.length && selected.size < COMPACT_TODO_LIMIT;
    offset += 1
  ) {
    const index = reverse ? todos.length - 1 - offset : offset;
    if (todos[index]?.status === status) {
      selected.add(index);
    }
  }
}

function todoMarker(status: UiTodoStatus): string {
  switch (status) {
    case "pending":
      return "○";
    case "in_progress":
      return "●";
    case "completed":
      return "✓";
  }
}

function todoColor(
  status: UiTodoStatus,
  theme: ReturnType<typeof useTheme>,
): string {
  switch (status) {
    case "pending":
      return theme.text.dim;
    case "in_progress":
      return theme.status.accent;
    case "completed":
      return theme.status.success;
  }
}
