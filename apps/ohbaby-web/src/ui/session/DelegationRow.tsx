import { ChevronRight } from "lucide-react";
import type { ReactElement } from "react";
import type {
  UiMessage,
  UiSubagentExecution,
  UiToolCall,
  UiToolResult,
} from "ohbaby-sdk";
import { ToolCard } from "../conversation/tool-card.js";
import { useExecutionDuration } from "../conversation/use-execution-duration.js";

export function subagentStatusLabel(
  status: UiSubagentExecution["status"],
): string {
  return {
    queued: "Queued",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
    timed_out: "Timed out",
  }[status];
}
export function delegationExecution(
  message: UiMessage,
  call: UiToolCall,
  executions: readonly UiSubagentExecution[],
  rootSessionId: string,
): UiSubagentExecution | undefined {
  const exact = executions.find(
    (item) =>
      item.rootSessionId === rootSessionId &&
      item.requestId === JSON.stringify([message.id, call.id]),
  );
  if (exact) return exact;
  const part = message.parts.find(
    (part) => part.type === "tool-result" && part.result.callId === call.id,
  );
  const metadata = part?.metadata?.subagent as
    | { execution?: Partial<UiSubagentExecution> }
    | undefined;
  const old = metadata?.execution;
  if (!old?.executionId || !old.subagentId || !old.status) return undefined;
  return (
    executions.find(
      (item) =>
        item.rootSessionId === rootSessionId &&
        item.executionId === old.executionId,
    ) ?? {
      executionId: old.executionId,
      subagentId: old.subagentId,
      rootSessionId,
      rootRunId: message.runId ?? "",
      childSessionId: old.childSessionId,
      childScopeId: old.childScopeId,
      childRunId: old.childRunId,
      status: old.status,
      createdAt: Date.parse(message.createdAt),
      updatedAt: Date.parse(message.createdAt),
      resultStored: old.resultStored ?? false,
      delivery: "none",
    }
  );
}
export function delegationTitle(call: UiToolCall): string {
  const input = call.input;
  for (const key of ["description", "name", "prompt"])
    if (typeof input[key] === "string" && input[key])
      return input[key].split("\n")[0];
  return "Subagent task";
}
export function DelegationRow({
  call,
  execution,
  result,
  onOpen,
}: {
  readonly call: UiToolCall;
  readonly execution?: UiSubagentExecution;
  readonly result?: UiToolResult;
  readonly onOpen: (
    execution: UiSubagentExecution,
    trigger: HTMLButtonElement,
  ) => void;
}): ReactElement {
  const duration = useExecutionDuration(
    execution?.executionId ?? call.id,
    execution?.startedAt,
    execution?.completedAt,
  );
  if (!execution && (call.status === "failed" || result?.error !== undefined)) {
    return <ToolCard call={call} result={result} />;
  }
  return (
    <button
      type="button"
      className="ohb-delegation-row"
      disabled={!execution}
      onClick={(event) => {
        if (execution) onOpen(execution, event.currentTarget);
      }}
    >
      <span
        aria-hidden="true"
        className={`ohb-delegation-dot is-${execution?.status ?? "pending"}`}
      />
      <span className="ohb-delegation-copy">
        <span className="ohb-delegation-title">{delegationTitle(call)}</span>
        <span className="ohb-delegation-meta">
          {(execution ? subagentStatusLabel(execution.status) : undefined) ??
            (call.status === "failed" ? "Failed to start" : "Connecting…")}
          {duration ? (
            <span className="ohb-delegation-duration">{duration}</span>
          ) : null}
        </span>
      </span>
      <ChevronRight size={15} />
    </button>
  );
}
