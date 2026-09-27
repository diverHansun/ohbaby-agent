import { useExecutionDuration } from "../conversation/use-execution-duration.js";
import type { UiRun } from "ohbaby-sdk";
import type { ReactElement } from "react";
import type { UiSubagentReaderState, createSubagentReader } from "ohbaby-sdk";
import { ConversationStream } from "../conversation/ConversationStream.js";

type Reader = ReturnType<typeof createSubagentReader>;
export function SubagentTree({
  reader,
  state,
  run,
}: {
  readonly reader: Reader;
  readonly state: UiSubagentReaderState;
  readonly run?: UiRun;
}): ReactElement {
  const duration = useExecutionDuration(
    run?.id ?? "root",
    run ? Date.parse(run.startedAt) : undefined,
  );
  return (
    <section className="ohb-subagents" aria-label="Subagents">
      {state.list?.waiting ? (
        <p role="status">
          Waiting for subagents · {state.list.completedCount} done ·{" "}
          {state.list.activeCount} open
          {duration ? ` · elapsed ${duration}` : ""}
          {state.list.approvalBlocked ? " · approval required in root" : ""}
        </p>
      ) : null}
      <details>
        <summary>Subagents · {state.list?.executions.length ?? 0}</summary>
        <ul>
          {state.list?.executions.map((execution) => (
            <li key={execution.executionId}>
              <button
                type="button"
                onClick={() => {
                  reader.select(execution.executionId);
                }}
                aria-current={
                  state.selectedId === execution.executionId
                    ? "true"
                    : undefined
                }
              >
                {execution.subagentId} · {execution.status} ·{" "}
                {new Date(execution.updatedAt).toLocaleTimeString()}
              </button>
              <small> {execution.executionId}</small>
            </li>
          ))}
        </ul>
        {!state.selectedId && state.list?.hasMore ? (
          <button
            type="button"
            disabled={state.loading}
            onClick={() => {
              void reader.loadMore();
            }}
          >
            Load earlier executions
          </button>
        ) : null}
      </details>
      {state.error ? (
        <p role="alert">
          Could not read subagents: {state.error}{" "}
          <button
            type="button"
            onClick={() => {
              void reader.refresh();
            }}
          >
            Retry
          </button>
        </p>
      ) : null}
    </section>
  );
}
export function SubagentView({
  reader,
  state,
}: {
  readonly reader: Reader;
  readonly state: UiSubagentReaderState;
}): ReactElement {
  const view = state.view;
  const execution = view?.execution;
  return (
    <section
      className="ohb-subagent-view"
      aria-label="Read-only subagent execution"
    >
      <button
        type="button"
        onClick={() => {
          reader.select();
        }}
      >
        ← Back to root conversation
      </button>
      <h2>{execution?.subagentId ?? "Subagent"} · Read only</h2>
      <p>
        Prompts, approvals and stop controls are available in the root
        conversation.
      </p>
      {execution ? (
        <p role="status">
          {execution.status} · result{" "}
          {execution.resultStored ? "stored" : "pending"} · delivery{" "}
          {execution.delivery}
          {execution.processedRequestId
            ? ` · processed by ${execution.processedRequestId}`
            : ""}
          {execution.terminalReason ? ` · ${execution.terminalReason}` : ""}
        </p>
      ) : (
        <p>Loading execution…</p>
      )}
      {execution?.budget ? (
        <p>
          Elapsed {seconds(execution.budget.elapsedMs)} · active{" "}
          {seconds(execution.budget.activeMs)} · remaining{" "}
          {seconds(execution.budget.remainingMs)} · approval wait{" "}
          {seconds(execution.budget.approvalWaitMs)}
        </p>
      ) : (
        <p>Execution timing unavailable</p>
      )}
      {view?.reasoningMissing ? (
        <p role="status">
          Some reasoning could not be saved and is unavailable.
        </p>
      ) : null}
      <ConversationStream
        historyState={
          state.error ? "error" : state.loading ? "loading" : "ready"
        }
        historyHasMore={view?.history.hasMore ?? false}
        historyStale={false}
        historyError={state.error}
        onLoadHistory={() => reader.loadMore()}
        promptRows={[]}
        messages={view?.messages ?? []}
        sessionId={execution?.childSessionId ?? null}
        prompts={[]}
        activeRun={undefined}
        isRunning={false}
        reasoningByMessageId={{}}
        commandNotices={null}
      />
      {view?.output !== undefined ? (
        <details>
          <summary>Stored result</summary>
          <pre>{view.output}</pre>
        </details>
      ) : null}
      {view?.error ? <pre role="alert">{view.error}</pre> : null}
      {execution?.artifactPath ? (
        <p>
          Full result artifact: <code>{execution.artifactPath}</code>
        </p>
      ) : null}
    </section>
  );
}
function seconds(ms: number): string {
  return `${String(Math.floor(ms / 1000))}s`;
}
