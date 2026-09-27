import { useExecutionDuration } from "./execution-duration.js";
import type { UiRun } from "ohbaby-sdk";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { UiSubagentReaderState, createSubagentReader } from "ohbaby-sdk";
import { useTuiLayout } from "../layout/context.js";

export function SubagentBrowser({
  reader,
  state,
  onClose,
}: {
  readonly reader: ReturnType<typeof createSubagentReader>;
  readonly state: UiSubagentReaderState;
  readonly onClose: () => void;
}): ReactElement {
  const [selected, setSelected] = useState(0);
  const [offset, setOffset] = useState(0);
  const layout = useTuiLayout();
  useEffect(() => {
    setOffset(0);
  }, [state.selectedId]);
  const executions = state.list?.executions ?? [];
  const view = state.view;
  const lines = view
    ? view.messages
        .flatMap((message) => [
          `${message.role} · ${message.id}`,
          ...message.parts.flatMap((part) => {
            if (part.type === "text" || part.type === "reasoning")
              return [`${part.type}: ${part.text}`];
            if (part.type === "tool-call")
              return [
                `Tool ${part.call.name} (${part.call.status})`,
                JSON.stringify(part.call.input, null, 2),
              ];
            return [
              `Tool result ${part.result.callId}`,
              part.result.output,
              part.result.error ?? "",
            ];
          }),
          "",
        ])
        .concat(
          view.output === undefined ? [] : ["Stored result", view.output],
          view.error ? [view.error] : [],
        )
        .flatMap((line) =>
          line
            .split("\n")
            .flatMap((row) => wrap(row, Math.max(10, layout.contentWidth - 2))),
        )
    : [];
  const height = 20;
  useInput((value, key) => {
    if (key.escape) {
      if (state.selectedId) reader.select();
      else onClose();
      return;
    }
    if (value === "r") {
      void reader.refresh();
      return;
    }
    if (key.pageUp) {
      void reader.loadMore();
      return;
    }
    if (state.selectedId) {
      if (key.downArrow || key.pageDown || value === "j")
        setOffset((current) =>
          Math.min(
            Math.max(0, lines.length - height),
            current + (key.pageDown ? height : 1),
          ),
        );
      if (key.upArrow || value === "k")
        setOffset((current) => Math.max(0, current - 1));
    } else {
      if (key.downArrow)
        setSelected((current) => Math.min(executions.length - 1, current + 1));
      if (key.upArrow) setSelected((current) => Math.max(0, current - 1));
      if (key.return && executions[selected])
        reader.select(executions[selected].executionId);
    }
  });
  return (
    <Box flexDirection="column">
      <Text bold>Subagents · Read only · Esc back · Ctrl+G root · R retry</Text>
      <Text dimColor>
        Prompts, approvals and stop controls remain in the root conversation.
      </Text>
      {state.error ? <Text color="red">Read failed: {state.error}</Text> : null}
      {state.loading ? <Text dimColor>Loading…</Text> : null}
      {state.selectedId ? (
        <>
          <Text>
            {view?.execution.subagentId ?? state.selectedId} ·{" "}
            {view?.execution.status} · result{" "}
            {view?.execution.resultStored ? "stored" : "pending"} · delivery{" "}
            {view?.execution.delivery} · {view?.execution.terminalReason}
          </Text>
          <Text dimColor>
            {view?.execution.budget
              ? `Elapsed ${sec(view.execution.budget.elapsedMs)} · active ${sec(view.execution.budget.activeMs)} · remaining ${sec(view.execution.budget.remainingMs)} · approval wait ${sec(view.execution.budget.approvalWaitMs)}`
              : "Execution timing unavailable"}
          </Text>
          {view?.reasoningMissing ? (
            <Text color="yellow">Some reasoning is unavailable</Text>
          ) : null}
          {view?.execution.processedRequestId ? (
            <Text>Processed request: {view.execution.processedRequestId}</Text>
          ) : null}
          {view?.execution.artifactPath ? (
            <Text>Full result artifact: {view.execution.artifactPath}</Text>
          ) : null}
          <Text>{lines.slice(offset, offset + height).join("\n")}</Text>
          <Text dimColor>
            ↑/↓ scroll · PageDown next screen ·{" "}
            {Math.min(offset + height, lines.length)}/{lines.length} lines
            {view?.history.hasMore ? " · PageUp load earlier process" : ""}
          </Text>
        </>
      ) : (
        <>
          {executions.map((execution, index) => (
            <Text
              key={execution.executionId}
              color={selected === index ? "cyan" : undefined}
            >
              {selected === index ? "›" : " "} {execution.subagentId} ·{" "}
              {execution.status} · {execution.executionId} ·{" "}
              {new Date(execution.updatedAt).toLocaleTimeString()}
            </Text>
          ))}
          <Text dimColor>
            ↑/↓ select · Enter open execution
            {state.list?.hasMore ? " · PageUp earlier executions" : ""}
          </Text>
        </>
      )}
    </Box>
  );
}
function wrap(text: string, width: number): string[] {
  if (!text) return [""];
  const rows: string[] = [];
  for (let i = 0; i < text.length; i += width)
    rows.push(text.slice(i, i + width));
  return rows;
}
function sec(ms: number): string {
  return `${String(Math.floor(ms / 1000))}s`;
}

export function SubagentWait({
  state,
  run,
}: {
  readonly state: UiSubagentReaderState;
  readonly run?: UiRun;
}): ReactElement | null {
  const duration = useExecutionDuration(
    run?.id ?? "root",
    run ? Date.parse(run.startedAt) : undefined,
  );
  if (!state.list?.waiting) return null;
  return (
    <Text>
      Waiting for subagents · {state.list.completedCount} done ·{" "}
      {state.list.activeCount} open{duration ? ` · elapsed ${duration}` : ""}
      {state.list.approvalBlocked ? " · approval required" : ""}
    </Text>
  );
}
