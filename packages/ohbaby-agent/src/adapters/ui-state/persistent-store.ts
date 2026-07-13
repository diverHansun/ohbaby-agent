import type {
  UiMessage,
  UiMessagePart,
  UiPermissionRequest,
  UiRun,
  UiRunStatus,
  UiSession,
  UiSnapshot,
  UiToolCall,
} from "ohbaby-sdk";
import type {
  MessageManager,
  MessageWithParts,
  Part,
  ToolPart,
  ToolState,
} from "../../core/message/index.js";
import { isContextSummaryPart } from "../../core/message/index.js";
import { SUMMARY_AGENT_NAME } from "../../core/context/constants.js";
import { isActivePart } from "../../core/context/filters.js";
import type {
  RunLedger,
  RunLedgerRecord,
  RunStatus,
} from "../../runtime/run-ledger/index.js";
import {
  resolveSessionDisplayTitle,
  sameSessionProjectRoot,
  type Session,
  type SessionManager,
} from "../../services/session/index.js";
import { cloneSnapshot } from "./memory-store.js";
import type { UiStateStore } from "./types.js";

const DEFAULT_SESSION_LIMIT = 50;
const ACTIVE_RUN_STATUSES = new Set<RunStatus>(["pending", "running"]);
const SESSION_TRANSACTION_ACTIVE_MESSAGE = "Session transaction is active";
const CONTEXT_COMPACTED_TEXT = "Context compacted";
const HIDDEN_TRANSCRIPT_TOOLS = new Set(["todo_read", "todo_write"]);

export interface PersistentUiStateStoreOptions {
  readonly sessionManager: Pick<
    SessionManager,
    "get" | "listByProjectRoot" | "update"
  >;
  readonly messageManager: Pick<MessageManager, "listBySession">;
  readonly runLedger: RunLedger;
  readonly initialActiveSessionId?: string | null;
  readonly projectRoot: string | (() => Promise<string> | string);
  readonly sessionLimit?: number;
}

interface MutableUiState {
  permissions: UiPermissionRequest[];
  status: UiRunStatus;
}

function toIsoString(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function toolCallStatus(state: ToolState): UiToolCall["status"] {
  if (state.status === "error" || state.status === "aborted") {
    return "failed";
  }
  return state.status;
}

function toolInput(state: ToolState): Record<string, unknown> {
  return state.input;
}

function toolResultPart(part: ToolPart): UiMessagePart | undefined {
  if (part.state.status === "completed") {
    return {
      result: {
        callId: part.callId,
        output: part.state.output,
      },
      type: "tool-result",
    };
  }
  if (part.state.status === "error" || part.state.status === "aborted") {
    return {
      result: {
        callId: part.callId,
        error: displayToolError(part.state.error),
        output: "",
      },
      type: "tool-result",
    };
  }
  return undefined;
}

function toolPartToUiParts(part: ToolPart): UiMessagePart[] {
  const callPart: UiMessagePart = {
    call: {
      id: part.callId,
      input: toolInput(part.state),
      name: part.tool,
      status: toolCallStatus(part.state),
    },
    type: "tool-call",
  };
  const resultPart = toolResultPart(part);
  return resultPart ? [callPart, resultPart] : [callPart];
}

function partToUiParts(part: Part): UiMessagePart[] {
  if (part.type === "text") {
    return [{ text: part.text, type: "text" }];
  }
  if (part.type === "reasoning") {
    return [{ text: part.text, type: "reasoning" }];
  }
  if (HIDDEN_TRANSCRIPT_TOOLS.has(part.tool)) {
    return [];
  }
  return toolPartToUiParts(part);
}

export function messageToUiMessage(
  message: MessageWithParts,
): UiMessage | undefined {
  const activeParts = message.parts.filter(isActivePart);
  if (
    message.info.agent === SUMMARY_AGENT_NAME &&
    activeParts.some(isContextSummaryPart)
  ) {
    return {
      createdAt: toIsoString(message.info.time.created),
      id: message.info.id,
      parts: [{ text: CONTEXT_COMPACTED_TEXT, type: "text" }],
      role: "assistant",
    };
  }

  const parts = activeParts.flatMap(partToUiParts);
  if (parts.length === 0) {
    return undefined;
  }

  return {
    createdAt: toIsoString(message.info.time.created),
    id: message.info.id,
    parts,
    role: message.info.role,
    ...assistantCompletionFields(message.info),
  };
}

/**
 * Carries finish/status metadata into reloaded transcripts so UI affordances
 * that depend on them (e.g. the "output truncated" marker for
 * finishReason === "length") survive a restart.
 */
function assistantCompletionFields(
  info: MessageWithParts["info"],
): Pick<UiMessage, "finishReason" | "status"> {
  if (info.role !== "assistant") {
    return {};
  }

  const status =
    info.error !== undefined
      ? "error"
      : info.time.completed !== undefined
        ? "completed"
        : undefined;

  return {
    ...(info.finish === undefined ? {} : { finishReason: info.finish }),
    ...(status === undefined ? {} : { status }),
  };
}

function sessionToUiSession(input: {
  readonly session: Session;
  readonly messages: readonly MessageWithParts[];
}): UiSession {
  return {
    createdAt: toIsoString(input.session.createdAt),
    id: input.session.id,
    messages: input.messages
      .map(messageToUiMessage)
      .filter((message): message is UiMessage => message !== undefined),
    projectRoot: input.session.projectRoot,
    title: resolveSessionDisplayTitle({
      messages: input.messages,
      title: input.session.title,
    }),
    updatedAt: toIsoString(input.session.updatedAt),
  };
}

function runStatusToUiStatus(record: RunLedgerRecord): UiRunStatus {
  if (record.status === "pending" || record.status === "running") {
    return { kind: "running", runId: record.runId };
  }
  if (record.status === "succeeded" || record.status === "cancelled") {
    return { kind: "idle" };
  }
  return {
    kind: "error",
    message: record.error ?? `Run ${record.status}`,
    recoverable: true,
  };
}

function runToUiRun(record: RunLedgerRecord): UiRun {
  return {
    id: record.runId,
    sessionId: record.sessionId,
    startedAt: toIsoString(record.startedAt ?? record.createdAt),
    status: runStatusToUiStatus(record),
    updatedAt: toIsoString(
      record.endedAt ?? record.startedAt ?? record.createdAt,
    ),
  };
}

function displayToolError(error: string): string {
  try {
    const parsed = JSON.parse(error) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      "message" in parsed.error &&
      typeof parsed.error.message === "string"
    ) {
      return parsed.error.message;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      return parsed.message;
    }
  } catch {
    // Stored errors are often plain strings; keep them as-is.
  }
  return error;
}

function clonePermission(request: UiPermissionRequest): UiPermissionRequest {
  return {
    ...request,
    choices: request.choices.map((choice) => ({ ...choice })),
  };
}

function isActiveRun(record: RunLedgerRecord): boolean {
  return ACTIVE_RUN_STATUSES.has(record.status);
}

function isPrimarySession(session: Session): boolean {
  return !session.isSubagent;
}

function isSessionTransactionActiveError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(SESSION_TRANSACTION_ACTIVE_MESSAGE)
  );
}

async function afterAsyncBoundary(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function withSessionTransactionRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSessionTransactionActiveError(error) || attempt >= 20) {
        throw error;
      }
      await afterAsyncBoundary();
    }
  }
}

async function applyRunUpdate(runLedger: RunLedger, run: UiRun): Promise<void> {
  const existing = await runLedger.get(run.id);
  if (existing && existing.sessionId !== run.sessionId) {
    throw new Error(
      `Run id ${run.id} already belongs to session ${existing.sessionId}`,
    );
  }
  if (!existing) {
    await runLedger.createPending({
      runId: run.id,
      sessionId: run.sessionId,
      triggerSource: "user",
    });
  }
  const current = (await runLedger.get(run.id)) ?? existing;
  if (!current) {
    return;
  }

  if (
    run.status.kind === "running" ||
    run.status.kind === "waiting-for-permission"
  ) {
    if (current.status === "pending") {
      await runLedger.markRunning(run.id);
    }
    return;
  }

  if (run.status.kind === "idle") {
    if (current.status === "pending") {
      await runLedger.markRunning(run.id);
      await runLedger.markSucceeded(run.id);
    } else if (current.status === "running") {
      await runLedger.markSucceeded(run.id);
    }
    return;
  }

  if (current.status === "pending" || current.status === "running") {
    await runLedger.markFailed(run.id, run.status.message);
  }
}

export function createPersistentUiStateStore(
  options: PersistentUiStateStoreOptions,
): UiStateStore {
  const mutable: MutableUiState = {
    permissions: [],
    status: { kind: "idle" },
  };
  const sessionLimit = options.sessionLimit ?? DEFAULT_SESSION_LIMIT;
  let activeSessionId = options.initialActiveSessionId ?? null;

  async function currentProjectRoot(): Promise<string> {
    if (typeof options.projectRoot === "function") {
      return options.projectRoot();
    }
    return options.projectRoot;
  }

  function isInCurrentProject(session: Session, projectRoot: string): boolean {
    return sameSessionProjectRoot(session.projectRoot, projectRoot);
  }

  async function readUiSession(session: Session): Promise<UiSession> {
    return sessionToUiSession({
      messages: await options.messageManager.listBySession(session.id),
      session,
    });
  }

  async function readRuns(
    sessions: readonly Session[],
  ): Promise<RunLedgerRecord[]> {
    const runGroups = await Promise.all(
      sessions.map((session) => options.runLedger.listBySession(session.id)),
    );
    return runGroups
      .flat()
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async function readSessions(): Promise<{
    readonly activeSessionId: string | null;
    readonly sessions: readonly Session[];
  }> {
    const projectRoot = await currentProjectRoot();
    const selectedActiveSessionId = activeSessionId;
    const recentSessions = (
      await withSessionTransactionRetry(() =>
        options.sessionManager.listByProjectRoot(projectRoot, {
          limit: sessionLimit,
          status: "active",
        }),
      )
    ).filter(isPrimarySession);
    if (
      selectedActiveSessionId === null ||
      recentSessions.some((session) => session.id === selectedActiveSessionId)
    ) {
      return {
        activeSessionId: selectedActiveSessionId,
        sessions: recentSessions,
      };
    }

    const activeSession = await withSessionTransactionRetry(() =>
      options.sessionManager.get(selectedActiveSessionId),
    );
    if (
      activeSession?.status !== "active" ||
      !isPrimarySession(activeSession) ||
      !isInCurrentProject(activeSession, projectRoot)
    ) {
      return {
        activeSessionId: null,
        sessions: recentSessions,
      };
    }

    return {
      activeSessionId: selectedActiveSessionId,
      sessions: [...recentSessions, activeSession],
    };
  }

  function snapshotStatus(input: {
    readonly activeSessionId: string | null;
    readonly runs: readonly RunLedgerRecord[];
  }): UiRunStatus {
    if (mutable.status.kind !== "idle") {
      return { ...mutable.status };
    }
    if (input.activeSessionId === null) {
      return { kind: "idle" };
    }
    const activeRun = input.runs.find(
      (run) => run.sessionId === input.activeSessionId && isActiveRun(run),
    );
    return activeRun
      ? { kind: "running", runId: activeRun.runId }
      : { kind: "idle" };
  }

  return {
    requiresServiceManagersForWrites: true,

    async hasRun(runId: string): Promise<boolean> {
      return (await options.runLedger.get(runId)) !== undefined;
    },

    async readSnapshot(): Promise<UiSnapshot> {
      const { activeSessionId, sessions } = await readSessions();
      const runs = await readRuns(sessions);
      const snapshot: UiSnapshot = {
        activeSessionId,
        permissions: mutable.permissions.map(clonePermission),
        runs: runs.map(runToUiRun),
        sessions: await Promise.all(sessions.map(readUiSession)),
        status: snapshotStatus({ activeSessionId, runs }),
      };
      return cloneSnapshot(snapshot);
    },

    async getSession(sessionId: string): Promise<UiSession | undefined> {
      const session = await withSessionTransactionRetry(() =>
        options.sessionManager.get(sessionId),
      );
      const projectRoot = await currentProjectRoot();
      return session &&
        isPrimarySession(session) &&
        isInCurrentProject(session, projectRoot)
        ? readUiSession(session)
        : undefined;
    },

    async upsertSession(session: UiSession): Promise<void> {
      const existing = await withSessionTransactionRetry(() =>
        options.sessionManager.get(session.id),
      );
      if (!existing) {
        return;
      }
      if (existing.title !== session.title) {
        await withSessionTransactionRetry(() =>
          options.sessionManager.update(session.id, {
            title: session.title,
          }),
        );
      }
    },

    setActiveSessionId(sessionId: string | null): Promise<void> {
      activeSessionId = sessionId;
      return Promise.resolve();
    },

    addRun(run: UiRun): Promise<void> {
      return applyRunUpdate(options.runLedger, run);
    },

    updateRun(run: UiRun): Promise<void> {
      return applyRunUpdate(options.runLedger, run);
    },

    upsertPermission(request: UiPermissionRequest): Promise<void> {
      const cloned = clonePermission(request);
      const index = mutable.permissions.findIndex(
        (permission) => permission.id === cloned.id,
      );
      if (index === -1) {
        mutable.permissions = [...mutable.permissions, cloned];
      } else {
        mutable.permissions = mutable.permissions.map((permission, current) =>
          current === index ? cloned : permission,
        );
      }
      return Promise.resolve();
    },

    removePermission(requestId: string): Promise<void> {
      mutable.permissions = mutable.permissions.filter(
        (permission) => permission.id !== requestId,
      );
      return Promise.resolve();
    },

    setStatus(status: UiRunStatus): Promise<void> {
      mutable.status = { ...status };
      return Promise.resolve();
    },
  };
}
