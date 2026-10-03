import { useExecutionDuration } from "./execution-duration.js";
import type { UiRun } from "ohbaby-sdk";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { UiSubagentReaderState, createSubagentReader } from "ohbaby-sdk";
import { useTuiLayout } from "../layout/context.js";
import { useTheme } from "../theme/index.js";
import { isVisibleTranscriptMessage } from "../store/transcript.js";
import { renderMessageParts } from "./message/message-row.js";
import { wrapAnsi } from "../render/wrap.js";

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
  const theme = useTheme();
  useEffect(() => {
    setOffset(0);
  }, [state.selectedId]);
  const executions = state.list?.executions ?? [];
  const view = state.view;
  const width = Math.max(1, layout.contentWidth);
  const title = "Subagents · Read only · Esc back · Ctrl+G root · R retry";
  const explanation =
    "Prompts, approvals and stop controls remain in the root conversation.";
  const summary = `${view?.execution.subagentId ?? state.selectedId ?? "unknown"} · ${view?.execution.status ?? "loading"} · result ${view?.execution.resultStored ? "stored" : "pending"} · delivery ${view?.execution.delivery ?? "pending"}${view?.execution.terminalReason ? ` · ${view.execution.terminalReason}` : ""}`;
  const timing = view?.execution.budget
    ? `Elapsed ${sec(view.execution.budget.elapsedMs)} · active ${sec(view.execution.budget.activeMs)} · remaining ${sec(view.execution.budget.remainingMs)} · approval wait ${sec(view.execution.budget.approvalWaitMs)}`
    : "Execution timing unavailable";
  const lines = view
    ? [
        ...(view.execution.processedRequestId
          ? [`Processed request: ${view.execution.processedRequestId}`]
          : []),
        ...(view.execution.artifactPath
          ? [`Full result artifact: ${view.execution.artifactPath}`]
          : []),
        ...view.messages
          .filter(isVisibleTranscriptMessage)
          .flatMap((message) => {
            const parts = message.parts.flatMap((part) => {
              if (part.type !== "tool-result") {
                // Share root rules, retaining complete browser result bodies below.
                return renderMessageParts(
                  { ...message, parts: [part], finishReason: undefined },
                  width,
                  theme,
                ).map((rendered) => {
                  const text =
                    rendered.kind === "text" ? rendered.text : rendered.label;
                  return part.type === "tool-call"
                    ? `${text} (${part.call.status})`
                    : text;
                });
              }
              return [
                `Tool result ${part.result.callId}`,
                part.result.output,
                part.result.error ?? "",
              ];
            });
            return parts.some((part) => part.trim() !== "")
              ? [`${message.role} · ${message.id}`, ...parts, ""]
              : [];
          }),
        ...(view.output === undefined ? [] : ["Stored result", view.output]),
        ...(view.error ? [view.error] : []),
      ].flatMap((line) => wrapAnsi(line, width))
    : [];
  const help = state.selectedId
    ? `↑/↓ scroll · PgUp/PgDn page · ${String(lines.length)}/${String(lines.length)} lines${view?.history.hasMore ? " · PgUp at top loads earlier" : ""}`
    : `↑/↓ select · Enter open execution${state.list?.hasMore ? " · PageUp earlier executions" : ""}`;
  // Reserve the root header/terminal cursor, then budget the actual wrapped
  // browser chrome. Metadata stays in the scrollable detail body.
  const fixedRows = [
    title,
    explanation,
    ...(state.error ? [`Read failed: ${state.error}`] : []),
    ...(state.loading ? ["Loading…"] : []),
    ...(state.selectedId ? [summary, timing] : []),
    help,
  ].reduce((rows, text) => rows + wrapAnsi(text, width).length, 0);
  const height = Math.max(1, layout.rows - 3 - fixedRows);
  const start = Math.min(offset, Math.max(0, lines.length - height));
  const selectedIndex = Math.max(0, Math.min(selected, executions.length - 1));
  const listStart = Math.max(0, selectedIndex - height + 1);
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
      if (state.selectedId && start > 0) setOffset(Math.max(0, start - height));
      else void reader.loadMore();
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
      if (key.upArrow || value === "k") setOffset(Math.max(0, start - 1));
    } else {
      if (key.downArrow)
        setSelected(Math.min(executions.length - 1, selectedIndex + 1));
      if (key.upArrow) setSelected(Math.max(0, selectedIndex - 1));
      if (key.return && executions[selectedIndex])
        reader.select(executions[selectedIndex].executionId);
    }
  });
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dimColor>{explanation}</Text>
      {state.error ? <Text color="red">Read failed: {state.error}</Text> : null}
      {state.loading ? <Text dimColor>Loading…</Text> : null}
      {state.selectedId ? (
        <>
          <Text>{summary}</Text>
          <Text dimColor>{timing}</Text>
          <Text>{lines.slice(start, start + height).join("\n")}</Text>
          <Text dimColor>
            {help.replace(
              `${String(lines.length)}/${String(lines.length)}`,
              `${String(Math.min(start + height, lines.length))}/${String(lines.length)}`,
            )}
          </Text>
        </>
      ) : (
        <>
          {executions
            .slice(listStart, listStart + height)
            .map((execution, index) => (
              <Text
                key={execution.executionId}
                wrap="truncate-end"
                color={selectedIndex === listStart + index ? "cyan" : undefined}
              >
                {selectedIndex === listStart + index ? "›" : " "}{" "}
                {execution.subagentId} · {execution.status} ·{" "}
                {execution.executionId} ·{" "}
                {new Date(execution.updatedAt).toLocaleTimeString()}
              </Text>
            ))}
          <Text dimColor>{help}</Text>
        </>
      )}
    </Box>
  );
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
  if (!state.list?.waiting) return null;
  return <VisibleSubagentWait state={state} run={run} />;
}

function VisibleSubagentWait({
  state,
  run,
}: {
  readonly state: UiSubagentReaderState;
  readonly run?: UiRun;
}): ReactElement {
  const duration = useExecutionDuration(
    run?.id ?? "root",
    run ? Date.parse(run.startedAt) : undefined,
  );
  return (
    <Text>
      Waiting for subagents · {state.list?.completedCount} done ·{" "}
      {state.list?.activeCount} open{duration ? ` · elapsed ${duration}` : ""}
      {state.list?.approvalBlocked ? " · approval required" : ""}
    </Text>
  );
}
