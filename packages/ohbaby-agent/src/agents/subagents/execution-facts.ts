import type {
  MessageManager,
  MessageWithParts,
  ToolPart,
} from "../../core/message/index.js";
import type { PermissionManager } from "../../permission/types.js";
import type { SubagentExecutionRecord } from "./execution-store.js";
import {
  classifyApprovalBlocking,
  type ApprovalBlocking,
} from "./approval-blocking.js";

export interface ExecutionFactView {
  readonly executionId: string;
  readonly subagentId: string;
  readonly childSessionId?: string;
  readonly childScopeId?: string;
  readonly childRunId?: string;
  readonly status: SubagentExecutionRecord["status"];
  readonly phase: string;
  readonly collectedAt: number;
  readonly lastActivityAt?: number;
  readonly currentTools: readonly {
    readonly callId: string;
    readonly name: string;
    readonly phase: string;
    readonly phaseStartedAt?: number;
    readonly waitReason?: string;
  }[];
  readonly recentTools: readonly {
    readonly name: string;
    readonly outcome: string;
    readonly endedAt?: number;
  }[];
  readonly omittedTools: number;
  readonly sourceTruncated?: boolean;
  readonly approval: ApprovalBlocking;
}
export async function collectExecutionFacts(input: {
  readonly execution: SubagentExecutionRecord;
  readonly messages: Pick<MessageManager, "listPageByRun">;
  readonly permissions?: Pick<PermissionManager, "listPending">;
  readonly now?: () => number;
}): Promise<ExecutionFactView> {
  const execution = input.execution;
  const base = {
    executionId: execution.executionId,
    subagentId: execution.subagentId,
    childSessionId: execution.childSessionId,
    childScopeId: execution.childScopeId,
    childRunId: execution.childRunId,
    status: execution.status,
    collectedAt: (input.now ?? Date.now)(),
  };
  if (
    !execution.childSessionId ||
    !execution.childRunId ||
    !execution.childScopeId
  )
    return {
      ...base,
      phase: execution.status === "queued" ? "queued" : "unknown",
      currentTools: [],
      recentTools: [],
      omittedTools: 0,
      approval: { blocked: false, permissionIds: [] },
    };
  const page = await input.messages.listPageByRun(
    execution.childSessionId,
    execution.childRunId,
    { limit: 50, scope: { contextScopeId: execution.childScopeId } },
  );
  const messages = page.messages.filter(
    (message) =>
      message.info.runId === execution.childRunId &&
      message.info.contextScopeId === execution.childScopeId,
  );
  const tools: { message: MessageWithParts; part: ToolPart }[] =
    messages.flatMap((message) =>
      message.parts
        .filter((part): part is ToolPart => part.type === "tool")
        .map((part) => ({ message, part })),
    );
  const active = tools.filter(
    ({ part }) =>
      part.metadata?.execution?.phase !== "ended" &&
      (part.state.status === "pending" || part.state.status === "running"),
  );
  const requests = messages.flatMap((message) =>
    message.info.role === "assistant" ? (message.info.modelRequests ?? []) : [],
  );
  const requestsActive = requests.some(
    (request) => request.endedAt === undefined,
  );
  const approval = classifyApprovalBlocking({
    sessionId: execution.childSessionId,
    contextScopeId: execution.childScopeId,
    runId: execution.childRunId,
    requestsActive: requestsActive || page.hasMore,
    permissions:
      input.permissions
        ?.listPending()
        .filter(
          (permission) => permission.rootSessionId === execution.rootSessionId,
        ) ?? [],
    tools: tools.map(({ message, part }) => ({
      callId: part.callId,
      messageId: message.info.id,
      execution: part.metadata?.execution ?? {
        runId: execution.childRunId,
        phase: "preparing",
        phaseStartedAt: message.info.time.created,
        createdAt: message.info.time.created,
      },
    })),
  });
  const recent = tools
    .filter(({ part }) => part.metadata?.execution?.phase === "ended")
    .sort(
      (a, b) =>
        (b.part.metadata?.execution?.endedAt ?? 0) -
        (a.part.metadata?.execution?.endedAt ?? 0),
    );
  return {
    ...base,
    phase:
      execution.status !== "running" && execution.status !== "queued"
        ? "ended"
        : approval.blocked
          ? "awaiting-approval"
          : requestsActive
            ? "model-request"
            : (active[0]?.part.metadata?.execution?.phase ?? "unknown"),
    sourceTruncated: page.hasMore,
    lastActivityAt: messages.length
      ? Math.max(
          ...messages.map(
            (message) => message.info.time.updated ?? message.info.time.created,
          ),
        )
      : execution.startedAt,
    currentTools: active.slice(0, 20).map(({ part }) => ({
      callId: part.callId,
      name: part.tool.slice(0, 120),
      phase: part.metadata?.execution?.phase ?? "unknown",
      phaseStartedAt: part.metadata?.execution?.phaseStartedAt,
      waitReason: part.metadata?.execution?.waitReason,
    })),
    recentTools: recent.slice(0, 5).map(({ part }) => ({
      name: part.tool.slice(0, 120),
      outcome: part.metadata?.execution?.outcome ?? part.state.status,
      endedAt: part.metadata?.execution?.endedAt,
    })),
    omittedTools:
      Math.max(0, active.length - 20) + Math.max(0, recent.length - 5),
    approval,
  };
}

export function renderExecutionFacts(
  facts: readonly ExecutionFactView[],
): string {
  const selected = facts.slice(0, 20).map((fact) => ({
    ...fact,
    approval: {
      blocked: fact.approval.blocked,
      permissionIds: fact.approval.permissionIds.slice(0, 20),
    },
  }));
  let omitted = facts.length - selected.length;
  let text = JSON.stringify({
    executions: selected,
    omittedExecutions: omitted,
  });
  while (Buffer.byteLength(text, "utf8") > 16 * 1024 && selected.length) {
    selected.pop();
    omitted++;
    text = JSON.stringify({ executions: selected, omittedExecutions: omitted });
  }
  return text;
}
