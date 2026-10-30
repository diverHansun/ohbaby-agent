import { Bot, ChevronRight } from "lucide-react";
import type { ReactElement } from "react";
import type {
  UiMessage,
  UiSubagentExecution,
  UiToolCall,
  UiToolResult,
} from "ohbaby-sdk";
import { ToolCard } from "../conversation/tool-card.js";
import { useExecutionDuration } from "../conversation/use-execution-duration.js";
import { Spinner } from "../shared/Spinner.js";

export function isDelegationCall(
  call: UiToolCall,
  execution?: UiSubagentExecution,
): boolean {
  return (
    call.name === "subagent_run" ||
    (call.name === "agent" &&
      (call.input.action === "spawn" ||
        (call.input.action === "send" && execution !== undefined)))
  );
}

function subagentStatusLabel(status: UiSubagentExecution["status"]): string {
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
  // A send carries its text as `message`; the instance name comes from the snapshot.
  for (const key of ["description", "name", "prompt", "message"])
    if (typeof input[key] === "string" && input[key])
      return input[key].split("\n")[0];
  return "Subagent task";
}
/**
 * Whether the tool result says no execution started: a full or failed spawn,
 * or a send delivered to an instance that is already running. Unknown before
 * the result arrives and for legacy records.
 */
export function delegationNotStarted(
  message: UiMessage,
  call: UiToolCall,
): boolean {
  const part = message.parts.find(
    (item) => item.type === "tool-result" && item.result.callId === call.id,
  );
  const metadata = part?.metadata?.subagent as
    | { readonly started?: boolean }
    | undefined;
  return metadata?.started === false;
}

/**
 * The agent tool card, kept whole (D39), with an entry line under it once an
 * execution really started. The entry opens the instance in the right panel
 * at this delegation; it is withdrawn when the instance is closed.
 */
export function DelegationRow({
  call,
  execution,
  result,
  instanceName,
  available,
  onOpen,
}: {
  readonly call: UiToolCall;
  readonly execution?: UiSubagentExecution;
  readonly result?: UiToolResult;
  /** The instance's stable name from the session snapshot, when loaded. */
  readonly instanceName?: string;
  /** False once the instance is closed or the result says nothing started. */
  readonly available: boolean;
  readonly onOpen?: (input: {
    readonly subagentId: string;
    readonly executionId: string;
  }) => void;
}): ReactElement {
  const duration = useExecutionDuration(
    execution?.executionId ?? call.id,
    execution?.startedAt,
    execution?.completedAt,
  );
  const title = instanceName ?? delegationTitle(call);
  return (
    <div className="ohb-delegation">
      <ToolCard call={call} result={result} />
      {execution && available && onOpen ? (
        <button
          type="button"
          className="ohb-delegation-row"
          aria-label={`Open ${title} in Subagents`}
          onClick={() => {
            onOpen({
              subagentId: execution.subagentId,
              executionId: execution.executionId,
            });
          }}
        >
          {execution.status === "running" ? (
            <Spinner size={13} />
          ) : (
            <Bot aria-hidden="true" className="ohb-delegation-icon" size={14} />
          )}
          <span className={`ohb-delegation-copy is-${execution.status}`}>
            <span className="ohb-delegation-title">{title}</span>
            <span className="ohb-delegation-meta">
              {subagentStatusLabel(execution.status)}
              {duration ? (
                <span className="ohb-delegation-duration">{duration}</span>
              ) : null}
            </span>
          </span>
          <ChevronRight aria-hidden="true" size={15} />
        </button>
      ) : null}
    </div>
  );
}
