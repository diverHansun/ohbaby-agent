import { isValidOwnerPid } from "../../utils/process-owner.js";
import {
  createDatabaseWriteBudget,
  withDatabaseWriteBudget,
} from "../../services/database/write-budget.js";
import type { MessageManager } from "../../core/message/index.js";
import type {
  SubagentExecutionStore,
  SubagentExecutionRecord,
} from "../../agents/subagents/execution-store.js";
import type { SubagentInstanceStore } from "../../agents/subagents/types.js";
import type { RunLedger, RunLedgerRecord } from "../run-ledger/index.js";
import type { PromptSubmissionStore } from "../prompt-scheduler/types.js";
import type { CurrentRunInputStore } from "../prompt-scheduler/current-run-inputs.js";
import { repairInterruptedRunHistory } from "./history.js";

interface SessionRecoveryOptions {
  readonly runs: RunLedger;
  readonly prompts: PromptSubmissionStore;
  readonly inputs: CurrentRunInputStore;
  readonly executions: SubagentExecutionStore;
  readonly instances: SubagentInstanceStore;
  readonly messages: MessageManager;
  readonly ownerId: string;
  readonly scopeKey: string;
  readonly now?: () => number;
  readonly isOwnerAlive?: (pid: number) => boolean;
}

function ownerAlive(pid: number): boolean {
  if (!isValidOwnerPid(pid)) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function active(run: RunLedgerRecord): boolean {
  return run.status === "pending" || run.status === "running";
}

/** Explicit entry gate. A failed attempt is kept blocked by its caller, never polled. */
export function createSessionExecutionRecovery(
  options: SessionRecoveryOptions,
): (sessionId: string) => Promise<void> {
  const attempts = new Map<string, Promise<void>>();
  // Only inputs/history of this exact terminal snapshot are checked. Every entry
  // still reads current owners and child eligibility; this is not a session gate cache.
  const checkedHistories = new Map<string, string>();
  const alive = options.isOwnerAlive ?? ownerAlive;
  const now = options.now ?? Date.now;
  const recoverable = (run: RunLedgerRecord): boolean =>
    run.endTimeSource === "recovery" ||
    (isValidOwnerPid(run.ownerPid) && !alive(run.ownerPid));
  async function repair(sessionId: string): Promise<void> {
    // Parse all facts before changing child eligibility. Invalid roots stay local.
    const prompts = await options.prompts.listForSession(
      options.scopeKey,
      sessionId,
    );
    for (const prompt of prompts) {
      if (
        (prompt.status === "queued" ||
          prompt.status === "starting" ||
          prompt.status === "running") &&
        (!prompt.ownerId || !isValidOwnerPid(prompt.ownerPid))
      )
        throw new Error(
          `Recovery blocked: Prompt ${prompt.promptId} has an unknown owner in session ${sessionId}`,
        );
    }
    const runs = await options.runs.listBySession(sessionId);
    const executions: SubagentExecutionRecord[] = [];
    let before: { createdAt: number; executionId: string } | undefined;
    for (;;) {
      const page = await options.executions.list({
        rootSessionId: sessionId,
        limit: 200,
        before,
      });
      executions.push(...page);
      if (page.length < 200) break;
      const last = page.at(-1);
      if (!last) break;
      before = { createdAt: last.createdAt, executionId: last.executionId };
    }
    const byId = new Map(runs.map((run) => [run.runId, run]));
    for (const execution of executions) {
      const root =
        byId.get(execution.rootRunId) ??
        (await options.runs.get(execution.rootRunId));
      if (root?.sessionId !== sessionId || root.contextScopeId !== undefined)
        throw new Error(
          `Recovery blocked: missing or invalid root ${execution.rootRunId}`,
        );
      byId.set(root.runId, root);
      if (execution.childRunId) {
        const child = await options.runs.get(execution.childRunId);
        if (
          !child ||
          child.sessionId !== execution.childSessionId ||
          child.contextScopeId !== execution.childScopeId
        )
          throw new Error(
            `Recovery blocked: invalid child Run ${execution.childRunId}`,
          );
        byId.set(child.runId, child);
        if (
          (child.status === "running" || child.status === "pending") &&
          (!isValidOwnerPid(child.ownerPid) ||
            (recoverable(root) && !recoverable(child)))
        )
          throw new Error(
            `Recovery blocked: child ${child.runId} belongs to a live or unknown owner`,
          );
      }
    }
    for (const run of runs) {
      if (
        (run.status === "pending" || run.status === "running") &&
        !recoverable(run) &&
        (!isValidOwnerPid(run.ownerPid) || !run.ownerId)
      )
        throw new Error(
          `Recovery blocked: Run ${run.runId} belongs to a live or unknown owner`,
        );
    }
    const fact = (runId: string): RunLedgerRecord => {
      const run = byId.get(runId);
      if (!run) throw new Error(`Recovery blocked: missing Run ${runId}`);
      return run;
    };
    const affectedExecutions = executions.filter(
      (execution) =>
        recoverable(fact(execution.rootRunId)) ||
        (execution.childRunId !== undefined &&
          recoverable(fact(execution.childRunId))),
    );
    const instanceRepairs = [];
    for (const subagentId of new Set(
      affectedExecutions.map((execution) => execution.subagentId),
    )) {
      const affected = affectedExecutions.filter(
        (execution) => execution.subagentId === subagentId,
      );
      const first = affected.at(0);
      if (!first) continue;
      const instance = await options.instances.get({
        subagentId,
        parentSessionId: first.parentSessionId,
      });
      if (!instance) continue;
      const ids = new Set(affected.map((execution) => execution.executionId));
      const roots = new Set(
        affected
          .filter((execution) => recoverable(fact(execution.rootRunId)))
          .map((execution) => execution.rootRunId),
      );
      const belongs = (entry: typeof instance.currentInput): boolean =>
        !!entry &&
        ((entry.rootRunId !== undefined && roots.has(entry.rootRunId)) ||
          (entry.executionId !== undefined && ids.has(entry.executionId)));
      const current = belongs(instance.currentInput);
      if (
        current &&
        (!isValidOwnerPid(instance.ownerPid) || alive(instance.ownerPid))
      )
        throw new Error(
          `Recovery blocked: child instance ${subagentId} still has a live owner`,
        );
      const pendingQueue = instance.pendingQueue.filter(
        (entry) => !belongs(entry),
      );
      if (current || pendingQueue.length !== instance.pendingQueue.length)
        instanceRepairs.push({ instance, current, pendingQueue });
    }
    // Every mutation is idempotent. The gate remains closed across partial commits.
    for (const affectedSession of new Set(
      [...byId.values()]
        .filter((run) => active(run) && recoverable(run))
        .map((run) => run.sessionId),
    ))
      await options.runs.recoverOrphanedRuns({ sessionId: affectedSession });
    if (
      prompts.some(
        (prompt) =>
          (prompt.status === "queued" ||
            prompt.status === "starting" ||
            prompt.status === "running") &&
          isValidOwnerPid(prompt.ownerPid) &&
          !alive(prompt.ownerPid),
      )
    )
      await options.prompts.recoverAllInterrupted({
        sessionId,
        scopeKey: options.scopeKey,
      });
    for (const previous of byId.values()) {
      // Legacy observed terminals also need one history check: their input
      // closure never proved that every model request/tool result was saved.
      if (!recoverable(previous)) continue;
      if (checkedHistories.get(previous.runId) === JSON.stringify(previous))
        continue;
      let run = await options.runs.get(previous.runId);
      if (!run || active(run))
        throw new Error(
          `Recovery blocked: Run ${previous.runId} is still active`,
        );
      // CurrentRunInputStore treats this durable ledger field as the closure of
      // every input. Repeating close would open a write transaction for no change.
      if (run.inputsClosedAt === undefined) {
        await options.inputs.close(
          run.runId,
          run.inputsCloseReason ?? "process-interrupted",
        );
        run = await options.runs.get(previous.runId);
        if (!run || active(run) || run.inputsClosedAt === undefined)
          throw new Error(
            `Recovery blocked: Run ${previous.runId} inputs remain open`,
          );
      }
      await repairInterruptedRunHistory(options.messages, {
        sessionId: run.sessionId,
        contextScopeId: run.contextScopeId,
        runId: run.runId,
        reason: "process-interrupted",
        now,
      });
      // Commit progress per Run, so a later history/child write failure cannot
      // make every explicit retry spend its whole budget rechecking earlier Runs.
      checkedHistories.set(run.runId, JSON.stringify(run));
    }
    for (const execution of affectedExecutions)
      if (execution.status === "queued" || execution.status === "running")
        await options.executions.finish(
          {
            executionId: execution.executionId,
            parentSessionId: execution.parentSessionId,
          },
          {
            status: "interrupted",
            reason: "process-interrupted",
            completedAt: now(),
          },
        );
    for (const { instance } of instanceRepairs) {
      const affected = affectedExecutions.filter(
        (execution) => execution.subagentId === instance.subagentId,
      );
      await options.instances.recoverExecutionInputs({
        subagentId: instance.subagentId,
        executionIds: affected.map((execution) => execution.executionId),
        rootRunIds: affected
          .filter((execution) => recoverable(fact(execution.rootRunId)))
          .map((execution) => execution.rootRunId),
        expectedOwnerId: instance.ownerId,
        expectedOwnerPid: instance.ownerPid,
        expectedCurrentRunId: instance.currentRunId,
        at: now(),
      });
    }
  }
  return (sessionId): Promise<void> => {
    const existing = attempts.get(sessionId);
    if (existing) return existing;
    const attempt = Promise.resolve()
      .then(() =>
        withDatabaseWriteBudget(createDatabaseWriteBudget(), () =>
          repair(sessionId),
        ),
      )
      .finally(() => {
        if (attempts.get(sessionId) === attempt) attempts.delete(sessionId);
      });
    attempts.set(sessionId, attempt);
    return attempt;
  };
}
