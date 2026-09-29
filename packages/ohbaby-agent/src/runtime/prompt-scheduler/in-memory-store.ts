import { sameReasoning } from "./types.js";
/* eslint-disable @typescript-eslint/require-await -- The in-memory store intentionally implements the same async contract as SQLite. */
import { randomUUID } from "node:crypto";
import { isValidOwnerPid } from "../../utils/process-owner.js";
import {
  InvalidPromptClientRequestIdError,
  InvalidPromptTransitionError,
  PromptEditLeaseHeldError,
  PromptEditLeaseLostError,
  PromptIdempotencyConflictError,
  PromptNotQueuedError,
  PromptQueueFullError,
  PromptSubmissionNotFoundError,
  PromptVersionConflictError,
} from "./errors.js";
import type {
  AcceptPromptSubmissionInput,
  AcceptPromptSubmissionResult,
  FinishPromptSubmissionInput,
  PromptEditLease,
  PromptSubmissionRecord,
  PromptHistoryWindow,
  PromptSubmissionStore,
  PromptResubmissionReceipt,
  ResubmitRetainedPromptInput,
  ResubmitRetainedPromptResult,
  RecoverPromptSubmissionsOptions,
} from "./types.js";

export interface InMemoryPromptSubmissionStoreOptions {
  readonly now?: () => number;
  readonly ownerId?: string;
  readonly ownerPid?: number;
  readonly isOwnerAlive?: (pid: number) => boolean;
}

function clone(record: PromptSubmissionRecord): PromptSubmissionRecord {
  return {
    ...record,
    steerReceipt: record.steerReceipt ? { ...record.steerReceipt } : undefined,
    namingSource: record.namingSource ? { ...record.namingSource } : undefined,
    reasoning: record.reasoning ? { ...record.reasoning } : undefined,
    error: record.error ? { ...record.error } : undefined,
  };
}

function compareOrder(
  left: PromptSubmissionRecord,
  right: PromptSubmissionRecord,
): number {
  return (
    left.createdAt - right.createdAt ||
    left.promptId.localeCompare(right.promptId)
  );
}

export class InMemoryPromptSubmissionStore implements PromptSubmissionStore {
  private readonly records = new Map<string, PromptSubmissionRecord>();
  readonly runtimeInputMemory = {
    get: (id: string): PromptSubmissionRecord | undefined => {
      const r = this.records.get(id);
      return r ? structuredClone(r) : undefined;
    },
    all: (): readonly PromptSubmissionRecord[] =>
      [...this.records.values()].map((r) => structuredClone(r)),
    put: (record: PromptSubmissionRecord): void => {
      this.records.set(record.promptId, structuredClone(record));
    },
  };
  private readonly now: () => number;
  private lastCreatedAt = 0;
  private readonly ownerId: string;
  private readonly ownerPid: number;
  private readonly isOwnerAlive: (pid: number) => boolean;
  private readonly resubmissions = new Map<
    string,
    { text: string; receipt: PromptResubmissionReceipt }
  >();

  constructor(options: InMemoryPromptSubmissionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ownerId = options.ownerId ?? `owner_${randomUUID()}`;
    this.ownerPid = options.ownerPid ?? process.pid;
    this.isOwnerAlive =
      options.isOwnerAlive ??
      ((pid): boolean => {
        if (!isValidOwnerPid(pid)) return true;
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      });
  }

  async assertCapacity(
    scopeKey: string,
    maxQueuedPrompts: number,
  ): Promise<void> {
    const queuedCount = [...this.records.values()].filter(
      (record) => record.scopeKey === scopeKey && record.status === "queued",
    ).length;
    if (queuedCount >= maxQueuedPrompts) {
      throw new PromptQueueFullError(scopeKey, maxQueuedPrompts);
    }
  }

  async accept(
    input: AcceptPromptSubmissionInput,
  ): Promise<AcceptPromptSubmissionResult> {
    if (
      input.clientRequestId.trim() === "" ||
      input.clientRequestId.startsWith("legacy:")
    ) {
      throw new InvalidPromptClientRequestIdError(input.clientRequestId);
    }
    const existing = [...this.records.values()].find(
      (record) =>
        record.scopeKey === input.scopeKey &&
        record.clientRequestId === input.clientRequestId,
    );
    if (existing) {
      if (
        existing.sessionId !== input.sessionId ||
        existing.text !== input.text ||
        !sameReasoning(existing.reasoning, input.reasoning)
      ) {
        throw new PromptIdempotencyConflictError(input.clientRequestId);
      }
      return { record: clone(existing), inserted: false };
    }
    if (this.records.has(input.promptId)) {
      throw new InvalidPromptTransitionError(
        input.promptId,
        "existing",
        "queued",
      );
    }
    const queuedCount = [...this.records.values()].filter(
      (record) =>
        record.scopeKey === input.scopeKey && record.status === "queued",
    ).length;
    if (queuedCount >= input.maxQueuedPrompts) {
      throw new PromptQueueFullError(input.scopeKey, input.maxQueuedPrompts);
    }
    const at = Math.max(
      this.now(),
      this.lastCreatedAt + 1,
      ...[...this.records.values()]
        .filter((r) => r.scopeKey === input.scopeKey)
        .map((r) => r.acceptedAt ?? r.createdAt),
    );
    this.lastCreatedAt = at;
    const record: PromptSubmissionRecord = {
      promptId: input.promptId,
      clientRequestId: input.clientRequestId,
      scopeKey: input.scopeKey,
      sessionId: input.sessionId,
      userMessageId: input.userMessageId,
      text: input.text,
      titleExpected: input.titleExpected,
      namingSource: input.namingSource ? { ...input.namingSource } : undefined,
      reasoning: input.reasoning ? { ...input.reasoning } : undefined,
      status: "queued",
      ownerId: this.ownerId,
      ownerPid: this.ownerPid,
      acceptedAt: at,
      admissionOrder: this.nextAdmissionOrder(input.scopeKey),
      createdAt: at,
      updatedAt: at,
    };
    this.records.set(record.promptId, record);
    return { record: clone(record), inserted: true };
  }

  async get(promptId: string): Promise<PromptSubmissionRecord | undefined> {
    const record = this.records.get(promptId);
    return record ? clone(record) : undefined;
  }

  async getByClientRequestId(
    scopeKey: string,
    clientRequestId: string,
  ): Promise<PromptSubmissionRecord | undefined> {
    const record = [...this.records.values()].find(
      (candidate) =>
        candidate.scopeKey === scopeKey &&
        candidate.clientRequestId === clientRequestId,
    );
    return record ? clone(record) : undefined;
  }

  async acquireEditLease(
    promptId: string,
    ownerClientId: string,
    ttlMs: number,
  ): Promise<PromptEditLease> {
    const current = this.require(promptId);
    this.assertQueued(current);
    const now = this.now();
    if (
      current.editLeaseId !== undefined &&
      (current.editLeaseExpiresAt ?? 0) > now
    ) {
      throw new PromptEditLeaseHeldError(promptId);
    }
    const editLeaseId = `lease_${randomUUID()}`;
    const expiresAt = now + ttlMs;
    const updated: PromptSubmissionRecord = {
      ...current,
      editLeaseId,
      editLeaseOwnerId: ownerClientId,
      editLeaseExpiresAt: expiresAt,
      updatedAt: this.nextTime(current),
    };
    this.records.set(promptId, updated);
    return {
      editLeaseId,
      ownerClientId,
      expiresAt,
      prompt: clone(updated),
    };
  }

  async renewEditLease(
    promptId: string,
    editLeaseId: string,
    ownerClientId: string,
    ttlMs: number,
  ): Promise<PromptEditLease> {
    const current = this.require(promptId);
    this.assertLease(current, editLeaseId, ownerClientId);
    const expiresAt = this.now() + ttlMs;
    const updated: PromptSubmissionRecord = {
      ...current,
      editLeaseOwnerId: ownerClientId,
      editLeaseExpiresAt: expiresAt,
      updatedAt: this.nextTime(current),
    };
    this.records.set(promptId, updated);
    return {
      editLeaseId,
      ownerClientId,
      expiresAt,
      prompt: clone(updated),
    };
  }

  async commitEdit(
    promptId: string,
    editLeaseId: string,
    text: string,
    ownerClientId?: string,
  ): Promise<PromptSubmissionRecord> {
    const current = this.require(promptId);
    this.assertLease(current, editLeaseId, ownerClientId);
    const updated: PromptSubmissionRecord = {
      ...current,
      text,
      namingSource: text === current.text ? current.namingSource : undefined,
      editLeaseId: undefined,
      editLeaseOwnerId: undefined,
      editLeaseExpiresAt: undefined,
      updatedAt: this.nextTime(current),
    };
    this.records.set(promptId, updated);
    return clone(updated);
  }

  async releaseEditLease(
    promptId: string,
    editLeaseId: string,
    ownerClientId?: string,
  ): Promise<PromptSubmissionRecord> {
    const current = this.require(promptId);
    this.assertLease(current, editLeaseId, ownerClientId);
    const updated: PromptSubmissionRecord = {
      ...current,
      editLeaseId: undefined,
      editLeaseOwnerId: undefined,
      editLeaseExpiresAt: undefined,
      updatedAt: this.nextTime(current),
    };
    this.records.set(promptId, updated);
    return clone(updated);
  }

  async cancelQueued(
    promptId: string,
    editLeaseId?: string,
    ownerClientId?: string,
  ): Promise<PromptSubmissionRecord> {
    const current = this.require(promptId);
    this.assertQueued(current);
    if ((current.editLeaseExpiresAt ?? 0) > this.now()) {
      if (editLeaseId === undefined) {
        throw new PromptEditLeaseHeldError(promptId);
      }
      this.assertLease(current, editLeaseId, ownerClientId);
    }
    const at = this.nextTime(current);
    const updated: PromptSubmissionRecord = {
      ...current,
      status: "cancelled",
      editLeaseId: undefined,
      editLeaseOwnerId: undefined,
      editLeaseExpiresAt: undefined,
      updatedAt: at,
      endedAt: at,
    };
    this.records.set(promptId, updated);
    return clone(updated);
  }

  async claim(promptId: string): Promise<PromptSubmissionRecord | null> {
    const current = this.records.get(promptId);
    if (current?.status !== "queued" || !this.owns(current)) {
      return null;
    }
    if ((current.editLeaseExpiresAt ?? 0) > this.now()) {
      return null;
    }
    const at = this.nextTime(current);
    const updated: PromptSubmissionRecord = {
      ...current,
      status: "starting",
      editLeaseId: undefined,
      editLeaseOwnerId: undefined,
      editLeaseExpiresAt: undefined,
      updatedAt: at,
      startedAt: at,
    };
    this.records.set(promptId, updated);
    return clone(updated);
  }

  async markRunning(
    promptId: string,
    runId: string,
  ): Promise<PromptSubmissionRecord> {
    const current = this.require(promptId);
    this.assertOwned(current);
    if (current.status !== "starting") {
      throw new InvalidPromptTransitionError(
        promptId,
        current.status,
        "running",
      );
    }
    const updated: PromptSubmissionRecord = {
      ...current,
      status: "running",
      runId,
      updatedAt: this.nextTime(current),
    };
    this.records.set(promptId, updated);
    return clone(updated);
  }

  async requeueBusy(promptId: string): Promise<PromptSubmissionRecord> {
    const current = this.require(promptId);
    this.assertOwned(current);
    if (current.status !== "starting" || current.runId !== undefined) {
      throw new InvalidPromptTransitionError(
        promptId,
        current.status,
        "queued",
      );
    }
    const updated: PromptSubmissionRecord = {
      ...current,
      status: "queued",
      updatedAt: this.nextTime(current),
      startedAt: undefined,
    };
    this.records.set(promptId, updated);
    return clone(updated);
  }

  async finish(
    promptId: string,
    input: FinishPromptSubmissionInput,
  ): Promise<PromptSubmissionRecord> {
    const current = this.require(promptId);
    this.assertOwned(current);
    if (
      input.expectedRunId !== undefined &&
      current.runId !== input.expectedRunId
    )
      throw new PromptVersionConflictError(promptId);
    if (
      ["succeeded", "failed", "cancelled", "interrupted"].includes(
        current.status,
      )
    )
      return clone(current);
    if (current.status !== "starting" && current.status !== "running")
      throw new InvalidPromptTransitionError(
        promptId,
        current.status,
        input.status,
      );
    const at = this.nextTime(current);
    const updated: PromptSubmissionRecord = {
      ...current,
      status: input.status,
      updatedAt: at,
      endedAt: input.endedAt ?? at,
      endTimeSource: input.endTimeSource,
      error: input.error,
    };
    this.records.set(promptId, updated);
    return clone(updated);
  }

  async listQueued(
    scopeKey: string,
  ): Promise<readonly PromptSubmissionRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.scopeKey === scopeKey &&
          record.status === "queued" &&
          this.owns(record),
      )
      .sort(
        (a, b) =>
          (a.acceptedAt ?? a.createdAt) - (b.acceptedAt ?? b.createdAt) ||
          (a.admissionOrder ?? 0) - (b.admissionOrder ?? 0) ||
          compareOrder(a, b),
      )
      .map(clone);
  }

  async listVisible(
    scopeKey: string,
  ): Promise<readonly PromptSubmissionRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.scopeKey === scopeKey)
      .sort(compareOrder)
      .map(clone);
  }

  async getSessionTitleExpected(
    scopeKey: string,
    sessionId: string,
  ): Promise<string | undefined> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.scopeKey === scopeKey &&
          record.sessionId === sessionId &&
          record.titleExpected !== undefined,
      )
      .sort((a, b) => a.createdAt - b.createdAt)[0]?.titleExpected;
  }

  async hasForSession(scopeKey: string, sessionId: string): Promise<boolean> {
    for (const record of this.records.values()) {
      if (record.scopeKey === scopeKey && record.sessionId === sessionId)
        return true;
    }
    return false;
  }

  async listForSession(
    scopeKey: string,
    sessionId: string,
    window: PromptHistoryWindow = {},
  ): Promise<readonly PromptSubmissionRecord[]> {
    const messageIds = new Set(window.messageIds ?? []);
    const runIds = new Set(window.runIds ?? []);
    return [...this.records.values()]
      .filter(
        (record) =>
          record.scopeKey === scopeKey &&
          record.sessionId === sessionId &&
          (record.status === "queued" ||
            record.status === "retained" ||
            record.status === "starting" ||
            record.status === "running" ||
            messageIds.has(record.userMessageId) ||
            (record.runId !== undefined && runIds.has(record.runId))),
      )
      .sort(compareOrder)
      .map(clone);
  }

  async listScopesWithQueued(): Promise<readonly string[]> {
    return [
      ...new Set(
        [...this.records.values()]
          .filter((record) => record.status === "queued" && this.owns(record))
          .map((record) => record.scopeKey),
      ),
    ].sort();
  }

  async resubmitRetained(
    input: ResubmitRetainedPromptInput,
  ): Promise<ResubmitRetainedPromptResult> {
    if (!input.operationId.trim() || input.operationId.startsWith("legacy:"))
      throw new InvalidPromptClientRequestIdError(input.operationId);
    const key = JSON.stringify([input.scopeKey, input.operationId]);
    const previous = this.resubmissions.get(key);
    if (previous) {
      if (
        previous.receipt.promptId !== input.promptId ||
        previous.text !== input.text
      )
        throw new PromptIdempotencyConflictError(input.operationId);
      return {
        record: clone(this.require(input.promptId)),
        receipt: { ...previous.receipt },
        inserted: false,
      };
    }
    const current = this.require(input.promptId);
    if (current.scopeKey !== input.scopeKey || current.status !== "retained")
      throw new PromptVersionConflictError(input.promptId);
    this.assertLease(current, input.editLeaseId, input.ownerClientId);
    if (!input.text.trim()) throw new Error("Prompt text must not be empty");
    const count = [...this.records.values()].filter(
      (r) => r.scopeKey === input.scopeKey && r.status === "queued",
    ).length;
    if (count >= input.maxQueuedPrompts)
      throw new PromptQueueFullError(input.scopeKey, input.maxQueuedPrompts);
    const acceptedAt = Math.max(
      this.now(),
      ...[...this.records.values()]
        .filter((r) => r.scopeKey === input.scopeKey)
        .map((r) => r.acceptedAt ?? r.createdAt),
    );
    const record: PromptSubmissionRecord = {
      ...current,
      text: input.text,
      namingSource:
        input.text === current.text ? current.namingSource : undefined,
      status: "queued",
      acceptedAt,
      admissionOrder: this.nextAdmissionOrder(input.scopeKey),
      ownerId: this.ownerId,
      ownerPid: this.ownerPid,
      updatedAt: this.nextTime(current),
      runId: undefined,
      startedAt: undefined,
      endedAt: undefined,
      endTimeSource: undefined,
      error: undefined,
      editLeaseId: undefined,
      editLeaseOwnerId: undefined,
      editLeaseExpiresAt: undefined,
    };
    const receipt: PromptResubmissionReceipt = {
      operationId: input.operationId,
      promptId: current.promptId,
      sessionId: current.sessionId,
      userMessageId: current.userMessageId,
      acceptedAt,
    };
    this.records.set(record.promptId, record);
    this.resubmissions.set(key, { text: input.text, receipt });
    return { record: clone(record), receipt: { ...receipt }, inserted: true };
  }

  async getResubmissionReceipt(
    scopeKey: string,
    operationId: string,
  ): Promise<PromptResubmissionReceipt | undefined> {
    const receipt = this.resubmissions.get(
      JSON.stringify([scopeKey, operationId]),
    )?.receipt;
    return receipt ? { ...receipt } : undefined;
  }

  async retainOwnedQueued(scopeKey?: string): Promise<number> {
    let count = 0;
    for (const current of this.records.values()) {
      if (
        current.status !== "queued" ||
        !this.owns(current) ||
        (scopeKey !== undefined && current.scopeKey !== scopeKey)
      )
        continue;
      this.records.set(current.promptId, {
        ...current,
        status: "retained",
        updatedAt: this.nextTime(current),
        endedAt: undefined,
        editLeaseId: undefined,
        editLeaseOwnerId: undefined,
        editLeaseExpiresAt: undefined,
      });
      count++;
    }
    return count;
  }

  async recoverInterrupted(scopeKey: string): Promise<number> {
    return this.recoverAllInterrupted({ scopeKey });
  }

  async recoverAllInterrupted(
    options: RecoverPromptSubmissionsOptions = {},
  ): Promise<number> {
    let count = 0;
    for (const current of this.records.values()) {
      if (
        !["queued", "starting", "running"].includes(current.status) ||
        (options.scopeKey !== undefined &&
          current.scopeKey !== options.scopeKey) ||
        (options.sessionId !== undefined &&
          current.sessionId !== options.sessionId)
      )
        continue;
      const unknown = !current.ownerId || !isValidOwnerPid(current.ownerPid);
      const recover = unknown
        ? options.recoverUnknownOwner === true
        : this.owns(current)
          ? options.includeCurrentOwner === true
          : !this.isOwnerAlive(current.ownerPid);
      if (!recover) continue;
      const at = this.nextTime(current);
      const retained = current.status === "queued";
      this.records.set(current.promptId, {
        ...current,
        status: retained ? "retained" : "interrupted",
        updatedAt: at,
        endedAt: retained ? undefined : at,
        endTimeSource: retained ? undefined : "recovery",
        editLeaseId: undefined,
        editLeaseOwnerId: undefined,
        editLeaseExpiresAt: undefined,
        error: retained
          ? undefined
          : {
              code: "PROCESS_INTERRUPTED",
              message: "Process interrupted before prompt completed",
              source: "runtime",
              retryable: true,
            },
      });
      count++;
    }
    return count;
  }

  private owns(record: PromptSubmissionRecord): boolean {
    return record.ownerId === this.ownerId && record.ownerPid === this.ownerPid;
  }
  private assertOwned(record: PromptSubmissionRecord): void {
    if (!this.owns(record))
      throw new PromptVersionConflictError(record.promptId);
  }
  private nextAdmissionOrder(scopeKey: string): number {
    return (
      Math.max(
        0,
        ...[...this.records.values()]
          .filter((r) => r.scopeKey === scopeKey)
          .map((r) => r.admissionOrder ?? 0),
      ) + 1
    );
  }

  private require(promptId: string): PromptSubmissionRecord {
    const record = this.records.get(promptId);
    if (!record) {
      throw new PromptSubmissionNotFoundError(promptId);
    }
    return record;
  }

  private assertQueued(record: PromptSubmissionRecord): void {
    if (record.status !== "queued" && record.status !== "retained") {
      throw new PromptNotQueuedError(record.promptId);
    }
  }

  private assertLease(
    record: PromptSubmissionRecord,
    editLeaseId: string,
    ownerClientId?: string,
  ): void {
    this.assertQueued(record);
    if (
      record.editLeaseId !== editLeaseId ||
      (ownerClientId !== undefined &&
        record.editLeaseOwnerId !== ownerClientId) ||
      (record.editLeaseExpiresAt ?? 0) <= this.now()
    ) {
      throw new PromptEditLeaseLostError(record.promptId);
    }
  }

  private nextTime(record: PromptSubmissionRecord): number {
    return Math.max(this.now(), record.updatedAt + 1);
  }
}
