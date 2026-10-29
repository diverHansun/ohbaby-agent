import type {
  MessageManager,
  MessageRole,
  MessageWithParts,
} from "../../core/message/index.js";
import { messageCursor } from "../../core/message/pagination.js";
import {
  isModelContextPart,
  isSystemReminderPart,
} from "../../core/message/origin.js";
import type {
  SubagentExecutionRecord,
  SubagentExecutionStore,
} from "./execution-store.js";
import type { SubagentInstanceRecord, SubagentInstanceStore } from "./types.js";

export interface SubagentMonitorInput {
  readonly parentSessionId: string;
  readonly parentContextScopeId?: string;
  readonly subagentIds: readonly string[];
  readonly cursors?: Readonly<Record<string, string>>;
}
export interface SubagentMonitorRecord {
  readonly messageId: string;
  readonly runId?: string;
  readonly role: MessageRole;
  readonly createdAt: number;
  /** Saved visible text, reasoning and tool records; never provider model-state. */
  readonly content: string;
  readonly truncated: boolean;
}
export type SubagentMonitorInstance = Pick<
  SubagentInstanceRecord,
  "name" | "description" | "status" | "createdAt" | "updatedAt" | "closedAt"
>;
export type SubagentMonitorExecution = Pick<
  SubagentExecutionRecord,
  | "executionId"
  | "status"
  | "mode"
  | "createdAt"
  | "startedAt"
  | "completedAt"
  | "updatedAt"
  | "prompt"
  | "output"
  | "error"
> & { readonly artifactPath?: string };
export interface SubagentMonitorTarget {
  readonly subagentId: string;
  readonly item?: SubagentMonitorInstance;
  readonly executions: readonly SubagentMonitorExecution[];
  readonly records: readonly SubagentMonitorRecord[];
  /** Resume toward older saved messages, scoped to this target and caller. */
  readonly cursor?: string;
  readonly truncated: boolean;
  readonly error?: { readonly code: string; readonly message: string };
}
export interface SubagentMonitorResult {
  readonly targets: readonly SubagentMonitorTarget[];
  readonly truncated: boolean;
}
const MAX_TARGETS = 6;
const RECORDS_PER_TARGET = 20;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_RECORD_BYTES = 2048;

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Count JSON escapes as well as UTF-8 bytes without cutting a surrogate pair. */
function excerpt(value: string, budget: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(value.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value.charAt(low - 1))) low--;
  return value.slice(0, low);
}

function failure(
  subagentId: string,
  code: string,
  message: string,
): SubagentMonitorTarget {
  return {
    subagentId,
    executions: [],
    records: [],
    truncated: false,
    error: { code, message },
  };
}

function callerScope(input: SubagentMonitorInput): string {
  return input.parentContextScopeId ?? "primary";
}

function encodeCursor(
  input: SubagentMonitorInput,
  subagentId: string,
  before: string,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      parentSessionId: input.parentSessionId,
      requesterScopeId: callerScope(input),
      subagentId,
      before,
    }),
  ).toString("base64url");
}

function decodeCursor(
  input: SubagentMonitorInput,
  subagentId: string,
): string | undefined {
  const cursor = input.cursors?.[subagentId];
  if (cursor === undefined) return undefined;
  try {
    if (typeof cursor !== "string" || cursor.length > 8192) throw new Error();
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown> | null;
    if (
      value?.version !== 1 ||
      value.parentSessionId !== input.parentSessionId ||
      value.requesterScopeId !== callerScope(input) ||
      value.subagentId !== subagentId ||
      typeof value.before !== "string" ||
      value.before.length === 0 ||
      value.before.length > 4096
    )
      throw new Error();
    return value.before;
  } catch {
    throw Object.assign(new Error("Invalid monitor cursor"), {
      code: "INVALID_MONITOR_CURSOR",
    });
  }
}

function savedContent(message: MessageWithParts): string {
  const parts: string[] = [];
  if (message.info.role === "assistant" && message.info.error)
    parts.push(JSON.stringify({ error: message.info.error }));
  for (const part of message.parts) {
    if (isModelContextPart(part) || isSystemReminderPart(part)) continue;
    if (part.type === "text")
      parts.push(
        typeof part.metadata?.displayText === "string"
          ? part.metadata.displayText
          : part.text,
      );
    else if (part.type === "reasoning") parts.push(`[reasoning]\n${part.text}`);
    else if (part.type === "tool")
      parts.push(
        JSON.stringify({ tool: part.tool, callId: part.callId, ...part.state }),
      );
  }
  return parts.join("\n");
}

export function createSubagentMonitor(options: {
  readonly instances: SubagentInstanceStore;
  readonly executions: SubagentExecutionStore;
  readonly messages: MessageManager;
}): (input: SubagentMonitorInput) => Promise<SubagentMonitorResult> {
  async function readTarget(
    input: SubagentMonitorInput,
    subagentId: string,
    budget: number,
  ): Promise<SubagentMonitorTarget> {
    const item = await options.instances.get({
      parentSessionId: input.parentSessionId,
      subagentId,
    });
    const lookup = {
      parentSessionId: input.parentSessionId,
      requesterScopeId: callerScope(input),
    };
    const candidate = item
      ? (await options.executions.list({ ...lookup, subagentId, limit: 1 }))[0]
      : undefined;
    // A caller-authorized row resolves the ledger root without assuming that a
    // nested caller's physical session is also the root. Root+instance queries
    // already use the store's stable acceptance order, including legacy rows.
    const latest = candidate
      ? (
          await options.executions.list({
            ...lookup,
            rootSessionId: candidate.rootSessionId,
            subagentId,
            limit: 1,
          })
        )[0]
      : undefined;
    if (
      item?.parentSessionId !== input.parentSessionId ||
      latest?.parentSessionId !== input.parentSessionId ||
      latest.requesterScopeId !== lookup.requesterScopeId ||
      latest.subagentId !== subagentId
    )
      return failure(
        subagentId,
        "SUBAGENT_NOT_FOUND",
        "Unknown subagent for this caller",
      );

    const executionRecords = [latest];
    if (
      item.currentInput?.executionId &&
      item.currentInput.executionId !== latest.executionId
    ) {
      const current = await options.executions.get({
        ...lookup,
        executionId: item.currentInput.executionId,
      });
      if (current?.subagentId === subagentId) executionRecords.unshift(current);
    }
    const clipping = { count: 0 };
    const short = (value: string | undefined): string | undefined => {
      if (value === undefined) return undefined;
      const text = excerpt(value, 256);
      if (text !== value) clipping.count++;
      return text;
    };
    const projectedItem: SubagentMonitorInstance = {
      name: short(item.name),
      description: short(item.description),
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      closedAt: item.closedAt,
    };
    const executions: SubagentMonitorExecution[] = executionRecords.map(
      (record) => ({
        executionId: record.executionId,
        status: record.status,
        mode: record.mode,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        prompt: short(record.prompt) ?? "",
        output: short(record.output),
        error: short(record.error),
        ...(record.artifact.state === "ready"
          ? { artifactPath: record.artifact.path }
          : {}),
      }),
    );
    const scope = { contextScopeId: item.contextScopeId };
    const page = await options.messages.listPageBySession(item.sessionId, {
      scope,
      limit: RECORDS_PER_TARGET,
      before: decodeCursor(input, subagentId),
    });
    if (
      page.messages.some(
        (message) =>
          message.info.sessionId !== item.sessionId ||
          message.info.contextScopeId !== item.contextScopeId,
      )
    )
      return failure(
        subagentId,
        "SUBAGENT_NOT_FOUND",
        "Saved history does not match this subagent",
      );
    let target: SubagentMonitorTarget = {
      subagentId,
      item: projectedItem,
      executions,
      records: [],
      truncated: clipping.count > 0 || page.hasMore,
    };
    if (bytes(target) > budget)
      return failure(
        subagentId,
        "MONITOR_OUTPUT_LIMIT",
        "Saved identity or output reference exceeds the monitor budget",
      );

    // Keep the newest records first when the byte budget is tighter than the page limit.
    // The continuation starts before the oldest record actually returned, never before an omitted one.
    for (let index = page.messages.length - 1; index >= 0; index--) {
      const message = page.messages[index];
      const content = savedContent(message);
      let record: SubagentMonitorRecord = {
        messageId: message.info.id,
        runId: message.info.runId,
        role: message.info.role,
        createdAt: message.info.time.created,
        content: excerpt(content, MAX_RECORD_BYTES),
        truncated: false,
      };
      record = { ...record, truncated: record.content !== content };
      const cursor =
        page.hasMore || index > 0
          ? encodeCursor(
              input,
              subagentId,
              messageCursor(item.sessionId, message.info, { scope }),
            )
          : undefined;
      const candidate = (
        value: SubagentMonitorRecord,
      ): SubagentMonitorTarget => ({
        ...target,
        records: [value, ...target.records],
        cursor,
        truncated:
          clipping.count > 0 ||
          target.records.some((saved) => saved.truncated) ||
          value.truncated ||
          page.hasMore ||
          index > 0,
      });
      let next = candidate(record);
      if (bytes(next) > budget) {
        if (target.records.length > 0) break;
        const available =
          budget -
          bytes(candidate({ ...record, content: "", truncated: true }));
        if (available < 2)
          return failure(
            subagentId,
            "MONITOR_OUTPUT_LIMIT",
            "Saved message identity exceeds the monitor budget",
          );
        record = {
          ...record,
          content: excerpt(content, available),
          truncated: true,
        };
        next = candidate(record);
      }
      target = next;
    }
    return target;
  }

  return async (input): Promise<SubagentMonitorResult> => {
    if (
      !input.parentSessionId ||
      input.subagentIds.length < 1 ||
      input.subagentIds.length > MAX_TARGETS ||
      input.subagentIds.some(
        (id) => typeof id !== "string" || id.length === 0 || id.length > 256,
      )
    )
      throw Object.assign(
        new Error("Monitor requires one to six nonempty subagent IDs"),
        { code: "INVALID_MONITOR_QUERY" },
      );
    const budget =
      Math.floor((MAX_OUTPUT_BYTES - 64) / input.subagentIds.length) - 1;
    const targets: SubagentMonitorTarget[] = [];
    for (const subagentId of input.subagentIds) {
      try {
        targets.push(await readTarget(input, subagentId, budget));
      } catch (error) {
        const invalidCursor =
          error instanceof Error &&
          "code" in error &&
          (error.code === "INVALID_MONITOR_CURSOR" ||
            error.code === "INVALID_SESSION_QUERY");
        targets.push(
          failure(
            subagentId,
            invalidCursor ? "INVALID_MONITOR_CURSOR" : "MONITOR_UNAVAILABLE",
            invalidCursor
              ? "Invalid monitor cursor"
              : "Unable to read saved subagent history",
          ),
        );
      }
    }
    return { targets, truncated: targets.some((target) => target.truncated) };
  };
}
