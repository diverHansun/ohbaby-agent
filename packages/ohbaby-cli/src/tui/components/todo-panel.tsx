import { Box, Text } from "ink";
import type { UiSessionTodoList, UiTodoItem, UiTodoStatus } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useTheme } from "../theme/index.js";

export const COMPACT_TODO_LIMIT = 5;

export interface TodoPanelProps {
  readonly expanded: boolean;
  readonly todoList: UiSessionTodoList | null;
}

export function TodoPanel({
  expanded,
  todoList,
}: TodoPanelProps): ReactElement | null {
  const theme = useTheme();
  if (!todoList || todoList.todos.length === 0 || !todoList.visible) {
    return null;
  }

  const hasOverflow = todoList.todos.length > COMPACT_TODO_LIMIT;
  const displayed = expanded
    ? todoList.todos
    : selectCompactTodos(todoList.todos);
  const hiddenCount = todoList.todos.length - displayed.length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.status.accent}>Tasks</Text>
        {hasOverflow && expanded ? (
          <Text dimColor>ctrl+t to collapse</Text>
        ) : null}
      </Box>
      {displayed.map((todo, index) => (
        <Box key={`${String(index)}:${todo.content}`}>
          <Text color={todoColor(todo.status, theme)}>
            {todoMarker(todo.status)}{" "}
          </Text>
          <Text dimColor={todo.status === "completed"}>{todo.content}</Text>
        </Box>
      ))}
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
