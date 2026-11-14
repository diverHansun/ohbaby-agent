import {
  readProcessIdentity,
  type ProcessIdentity,
} from "../shell/process-identity.js";
import { probeProcessTree, type ProcessTreeState } from "../shell/process.js";
import type {
  ShellJobPatch,
  ShellJobRecord,
  ShellJobStore,
} from "./shell-job-store.js";
import { initialShellJobNoticeState } from "./shell-job-notice.js";
import { randomUUID } from "node:crypto";

export interface ShellBackendIdentity {
  readonly ownerId: string;
  readonly pid: number;
  readonly startToken: string | null;
}

export interface ShellJobRecoveryStore extends Pick<ShellJobStore, "get"> {
  compareAndUpdate(
    jobId: string,
    expected: ShellJobPatch,
    patch: ShellJobPatch,
  ): Promise<boolean>;
}

export class ShellJobManagementError extends Error {
  constructor(
    readonly code:
      | "SHELL_JOB_OTHER_BACKEND"
      | "SHELL_JOB_CLEANUP_BUSY"
      | "SHELL_JOB_ABANDON_NOT_ALLOWED",
    message: string,
  ) {
    super(message);
    this.name = "ShellJobManagementError";
  }
}

interface RecoveryOptions {
  readonly store: ShellJobRecoveryStore;
  readonly backend: ShellBackendIdentity;
  readonly inspect?: (pid: number) => Promise<ProcessIdentity>;
  readonly probeGroup?: (pgid: number) => ProcessTreeState;
  readonly signalGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  readonly hasLocalHandle?: (jobId: string) => boolean;
  readonly termGraceMs?: number;
  readonly observationMs?: number;
}

function parseClaim(text: string | null): ShellBackendIdentity | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (
      typeof row.ownerId !== "string" ||
      typeof row.pid !== "number" ||
      !Number.isSafeInteger(row.pid) ||
      row.pid <= 0 ||
      (row.startToken !== null && typeof row.startToken !== "string")
    )
      return null;
    return { ownerId: row.ownerId, pid: row.pid, startToken: row.startToken };
  } catch {
    return null;
  }
}

function expectedOwnership(row: ShellJobRecord): ShellJobPatch {
  return {
    ownerId: row.ownerId,
    ownerPid: row.ownerPid,
    ownerStartToken: row.ownerStartToken,
    recoveryClaim: row.recoveryClaim,
    trackingReleasedAt: null,
  };
}

/** Recovery works on persisted facts; ordinary live handles remain Registry-owned. */
export class ShellJobRecovery {
  private readonly inspect: (pid: number) => Promise<ProcessIdentity>;
  private readonly pending = new Map<string, Promise<ShellJobRecord>>();
  constructor(private readonly options: RecoveryOptions) {
    this.inspect = options.inspect ?? readProcessIdentity;
  }

  /** Queries and quota admission may observe disappearance but never send a signal. */
  refresh(jobId: string): Promise<ShellJobRecord> {
    return this.reconcile(jobId, false);
  }
  recover(jobId: string): Promise<ShellJobRecord> {
    return this.reconcile(jobId, true);
  }

  async assertCanManage(jobId: string): Promise<void> {
    const row = this.require(jobId);
    if (row.trackingReleasedAt !== null || row.settledAt !== null) return;
    if (row.ownerId === this.options.backend.ownerId) return;
    if (await this.ownerDead(row)) return;
    throw new ShellJobManagementError(
      "SHELL_JOB_OTHER_BACKEND",
      "This task is managed by another running or unverifiable ohbaby backend. Return to the original Web/TUI backend to stop it.",
    );
  }

  async abandon(jobId: string, confirm: boolean): Promise<ShellJobRecord> {
    if (!confirm)
      throw new Error("Abandoning task tracking requires confirm=true.");
    const row = await this.refresh(jobId);
    if (row.trackingReleasedAt !== null) return row;
    if (
      row.status === null ||
      row.status === "running" ||
      row.cleanup !== "unconfirmed" ||
      this.options.hasLocalHandle?.(jobId) ||
      !(await this.ownerDead(row))
    ) {
      throw new ShellJobManagementError(
        "SHELL_JOB_ABANDON_NOT_ALLOWED",
        "Only an unresolved task whose managing backend has exited can be abandoned.",
      );
    }
    if (!(await this.claimAvailable(row.recoveryClaim)))
      throw new ShellJobManagementError(
        "SHELL_JOB_CLEANUP_BUSY",
        "Task recovery is still active.",
      );
    const changed = await this.options.store.compareAndUpdate(
      jobId,
      { ...expectedOwnership(row), status: row.status, cleanup: "unconfirmed" },
      { trackingReleasedAt: Date.now(), recoveryClaim: null },
    );
    if (!changed && this.require(jobId).trackingReleasedAt !== null)
      return this.require(jobId);
    if (!changed)
      throw new ShellJobManagementError(
        "SHELL_JOB_CLEANUP_BUSY",
        "Task cleanup changed; refresh and try again.",
      );
    return this.require(jobId);
  }

  private require(jobId: string): ShellJobRecord {
    const row = this.options.store.get(jobId);
    if (!row) throw new Error(`Unknown shell job "${jobId}".`);
    return row;
  }

  private async identityDead(
    pid: number | null,
    token: string | null,
  ): Promise<boolean> {
    if (pid === null) return false;
    const observed = await this.inspect(pid);
    return (
      observed.state === "absent" ||
      (observed.state === "present" &&
        token !== null &&
        observed.startToken !== token)
    );
  }

  private ownerDead(row: ShellJobRecord): Promise<boolean> {
    return this.identityDead(row.ownerPid, row.ownerStartToken);
  }

  private async claimAvailable(value: string | null): Promise<boolean> {
    if (value === null) return true;
    const claim = parseClaim(value);
    return (
      claim !== null && (await this.identityDead(claim.pid, claim.startToken))
    );
  }

  private reconcile(jobId: string, signal: boolean): Promise<ShellJobRecord> {
    const key = `${jobId}:${String(signal)}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = this.perform(jobId, signal).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, task);
    return task;
  }

  private groupState(row: ShellJobRecord): ProcessTreeState {
    if (row.pgid === null || !Number.isSafeInteger(row.pgid) || row.pgid <= 0)
      return "unknown";
    try {
      return (
        this.options.probeGroup?.(row.pgid) ??
        probeProcessTree({ pid: row.pgid })
      );
    } catch {
      return "unknown";
    }
  }

  private async perform(
    jobId: string,
    signal: boolean,
    retries = 2,
  ): Promise<ShellJobRecord> {
    const row = this.require(jobId);
    if (
      row.trackingReleasedAt !== null ||
      row.settledAt !== null ||
      row.ownerId === this.options.backend.ownerId ||
      this.options.hasLocalHandle?.(jobId) ||
      !(await this.ownerDead(row))
    )
      return row;
    if (!(await this.claimAvailable(row.recoveryClaim)))
      return this.require(jobId);
    const expected: ShellJobPatch = {
      ...expectedOwnership(row),
      status: row.status,
      cleanup: row.cleanup,
      settledAt: row.settledAt,
      resultReadyAt: row.resultReadyAt,
      pid: row.pid,
      pgid: row.pgid,
      processStartToken: row.processStartToken,
      outputComplete: row.outputComplete,
      ...(row.noticeState === null ? { noticeState: null } : {}),
    };
    if (!signal) {
      // A read-only probe does not acquire signal authority or block a startup
      // recovery. Its CAS cannot overwrite an active recovery or fresher facts.
      const group =
        row.cleanup === "confirmed" ? "stopped" : this.groupState(row);
      await this.options.store.compareAndUpdate(
        jobId,
        expected,
        this.resultPatch(row, group),
      );
      return this.require(jobId);
    }
    const claim = JSON.stringify({
      ...this.options.backend,
      attemptId: randomUUID(),
    });
    if (
      !(await this.options.store.compareAndUpdate(jobId, expected, {
        recoveryClaim: claim,
      }))
    ) {
      return retries > 0
        ? this.perform(jobId, true, retries - 1)
        : this.require(jobId);
    }
    try {
      // Confirmed disappearance permanently relinquishes the numeric group.
      const group =
        row.cleanup === "confirmed" ? "stopped" : await this.terminate(row);
      await this.options.store.compareAndUpdate(
        jobId,
        { recoveryClaim: claim, trackingReleasedAt: null },
        this.resultPatch(row, group),
      );
    } finally {
      // No signal/observation callback survives this release. If the release
      // cannot be persisted, another backend must prove the claimant dead.
      await this.options.store.compareAndUpdate(
        jobId,
        { recoveryClaim: claim, trackingReleasedAt: null },
        { recoveryClaim: null },
      );
    }
    return this.require(jobId);
  }

  private resultPatch(
    row: ShellJobRecord,
    group: ProcessTreeState,
  ): ShellJobPatch {
    const status =
      row.status === null || row.status === "running" ? "lost" : row.status;
    const now = Date.now();
    return {
      ...(status !== row.status ? { status, stopReason: null } : {}),
      cleanup: group === "stopped" ? "confirmed" : "unconfirmed",
      settledAt: group === "stopped" ? now : null,
      resultReadyAt: row.resultReadyAt ?? now,
      outputComplete: row.outputComplete ?? false,
      ...(row.noticeState === null
        ? { noticeState: initialShellJobNoticeState({ ...row, status }) }
        : {}),
    };
  }

  private async matchesTarget(row: ShellJobRecord): Promise<boolean> {
    if (
      row.pid === null ||
      row.pgid !== row.pid ||
      row.processStartToken === null
    )
      return false;
    const identity = await this.inspect(row.pid);
    return (
      identity.state === "present" &&
      identity.pid === row.pid &&
      identity.pgid === row.pgid &&
      identity.startToken === row.processStartToken
    );
  }

  private async terminate(row: ShellJobRecord): Promise<ProcessTreeState> {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const state = this.groupState(row);
      if (state !== "running") return state;
      if (!(await this.matchesTarget(row)) || row.pgid === null)
        return "unknown";
      try {
        if (this.options.signalGroup)
          this.options.signalGroup(row.pgid, signal);
        else process.kill(-row.pgid, signal);
      } catch {
        return this.groupState(row) === "stopped" ? "stopped" : "unknown";
      }
      const deadline =
        performance.now() +
        (signal === "SIGTERM"
          ? (this.options.termGraceMs ?? 200)
          : (this.options.observationMs ?? 1000));
      let observed = this.groupState(row);
      while (observed !== "stopped" && performance.now() < deadline) {
        await new Promise<void>((resolve) => {
          setTimeout(
            resolve,
            Math.min(20, Math.max(1, deadline - performance.now())),
          );
        });
        observed = this.groupState(row);
      }
      if (observed !== "running" || signal === "SIGKILL") return observed;
    }
    return "unknown";
  }
}
