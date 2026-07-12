/* eslint-disable @typescript-eslint/require-await -- The in-memory store intentionally implements the same async contract as SQLite. */
import { randomUUID } from "node:crypto";
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
  PromptSubmissionStore,
} from "./types.js";

export interface InMemoryPromptSubmissionStoreOptions {
  readonly now?: () => number;
}

function clone(record: PromptSubmissionRecord): PromptSubmissionRecord {
  return { ...record, error: record.error ? { ...record.error } : undefined };
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
  private readonly now: () => number;
  private lastCreatedAt = 0;

  constructor(options: InMemoryPromptSubmissionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
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
        existing.text !== input.text
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
    const at = Math.max(this.now(), this.lastCreatedAt + 1);
    this.lastCreatedAt = at;
    const record: PromptSubmissionRecord = {
      promptId: input.promptId,
      clientRequestId: input.clientRequestId,
      scopeKey: input.scopeKey,
      sessionId: input.sessionId,
      userMessageId: input.userMessageId,
      text: input.text,
      status: "queued",
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
    this.assertLease(current, editLeaseId);
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
  ): Promise<PromptSubmissionRecord> {
    const current = this.require(promptId);
    this.assertLease(current, editLeaseId);
    const updated: PromptSubmissionRecord = {
      ...current,
      text,
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
  ): Promise<PromptSubmissionRecord> {
    const current = this.require(promptId);
    this.assertLease(current, editLeaseId);
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
  ): Promise<PromptSubmissionRecord> {
    const current = this.require(promptId);
    this.assertQueued(current);
    if ((current.editLeaseExpiresAt ?? 0) > this.now()) {
      if (editLeaseId === undefined) {
        throw new PromptEditLeaseHeldError(promptId);
      }
      this.assertLease(current, editLeaseId);
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
    if (current?.status !== "queued") {
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
    if (current.status !== "starting" && current.status !== "running") {
      throw new InvalidPromptTransitionError(
        promptId,
        current.status,
        input.status,
      );
    }
    if (
      input.expectedRunId !== undefined &&
      current.runId !== input.expectedRunId
    ) {
      throw new PromptVersionConflictError(promptId);
    }
    const at = this.nextTime(current);
    const updated: PromptSubmissionRecord = {
      ...current,
      status: input.status,
      updatedAt: at,
      endedAt: at,
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
        (record) => record.scopeKey === scopeKey && record.status === "queued",
      )
      .sort(compareOrder)
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

  async listScopesWithQueued(): Promise<readonly string[]> {
    return [
      ...new Set(
        [...this.records.values()]
          .filter((record) => record.status === "queued")
          .map((record) => record.scopeKey),
      ),
    ].sort();
  }

  async recoverInterrupted(scopeKey: string): Promise<number> {
    let count = 0;
    for (const current of [...this.records.values()]) {
      if (
        current.scopeKey !== scopeKey ||
        (current.status !== "starting" && current.status !== "running")
      ) {
        continue;
      }
      const at = this.nextTime(current);
      this.records.set(current.promptId, {
        ...current,
        status: "interrupted",
        updatedAt: at,
        endedAt: at,
        error: {
          code: "PROCESS_INTERRUPTED",
          message: "Process interrupted before prompt completed",
          source: "runtime",
          retryable: true,
        },
      });
      count += 1;
    }
    return count;
  }

  private require(promptId: string): PromptSubmissionRecord {
    const record = this.records.get(promptId);
    if (!record) {
      throw new PromptSubmissionNotFoundError(promptId);
    }
    return record;
  }

  private assertQueued(record: PromptSubmissionRecord): void {
    if (record.status !== "queued") {
      throw new PromptNotQueuedError(record.promptId);
    }
  }

  private assertLease(
    record: PromptSubmissionRecord,
    editLeaseId: string,
  ): void {
    this.assertQueued(record);
    if (
      record.editLeaseId !== editLeaseId ||
      (record.editLeaseExpiresAt ?? 0) <= this.now()
    ) {
      throw new PromptEditLeaseLostError(record.promptId);
    }
  }

  private nextTime(record: PromptSubmissionRecord): number {
    return Math.max(this.now(), record.updatedAt + 1);
  }
}
