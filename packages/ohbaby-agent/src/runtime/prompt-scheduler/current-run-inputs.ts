import { RuntimeInputSnapshotChangedError } from "../../core/lifecycle/runtime-input-error.js";
/* eslint-disable @typescript-eslint/require-await -- Synchronous domain transitions implement an async persistence contract. */
import { isDeepStrictEqual } from "node:util";
import {
  getDatabase,
  runWriteTransaction,
  type DatabaseConnection,
} from "../../services/database/index.js";
import type {
  Message,
  MessageManager,
  MessageWithParts,
  Part,
  RuntimeInputOrigin,
} from "../../core/message/types.js";
import { applyMessagePatch } from "../../core/message/message-patch.js";
import type { ModelRequestRecord } from "../../core/llm-client/types.js";
import type { RunLedger, RunLedgerRecord } from "../run-ledger/types.js";
import type { PromptSubmissionRecord } from "./types.js";
import { InMemoryPromptSubmissionStore } from "./in-memory-store.js";
import {
  promptSubmissionRowToRecord,
  type PromptSubmissionRow,
} from "./database-store.js";

export interface SteerQueuedPromptInput {
  readonly promptId: string;
  readonly expectedRunId: string;
  readonly clientRequestId: string;
  readonly scopeKey: string;
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly agent?: string;
}
export interface SteerQueuedPromptReceipt {
  readonly promptId: string;
  readonly userMessageId: string;
  readonly inputId: string;
  readonly acceptedTargetRunId: string;
  readonly acceptedAt: number;
  readonly clientRequestId: string;
}
export interface CurrentRunInputRecord {
  readonly inputId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly source: RuntimeInputOrigin["kind"];
  readonly sourceId: string;
  readonly messageId: string;
  readonly acceptedAt: number;
  readonly firstAttemptRequestId?: string;
  readonly firstAttemptAt?: number;
  readonly processedRequestId?: string;
  readonly processedAt?: number;
  readonly closedAt?: number;
  readonly closeReason?: string;
  readonly observation?: {
    readonly waitGeneration: number;
    readonly reason: "deadline" | "approval-change";
    readonly approvalFingerprint?: string;
    readonly observedAt: number;
  };
}
export interface AcceptRuntimeInput {
  readonly inputId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly source: RuntimeInputOrigin["kind"];
  readonly sourceId: string;
  readonly message: MessageWithParts;
  readonly observation?: CurrentRunInputRecord["observation"];
}
export interface SteerQueuedPromptResult {
  readonly receipt: SteerQueuedPromptReceipt;
  readonly prompt: PromptSubmissionRecord;
  readonly message: MessageWithParts;
}
export interface CurrentRunInputStore {
  /** Pure fact query. The caller selects the latest user-stopped root run. */
  hasUnsentSteer(runId: string): Promise<boolean>;
  sealSteer(runId: string): Promise<void>;
  acceptRuntimeInput(input: AcceptRuntimeInput): Promise<CurrentRunInputRecord>;
  steerQueued(input: SteerQueuedPromptInput): Promise<SteerQueuedPromptResult>;
  getInput(inputId: string): Promise<CurrentRunInputRecord | undefined>;
  listPending(runId: string): Promise<readonly CurrentRunInputRecord[]>;
  getMessages(runId: string): Promise<readonly MessageWithParts[]>;
  filterModelHistory(
    messages: readonly MessageWithParts[],
  ): Promise<readonly MessageWithParts[]>;
  admitRequestAttempt(
    request: ModelRequestRecord,
    signal?: AbortSignal,
  ): Promise<void>;
  confirmRequestSuccess(requestId: string): Promise<readonly string[]>;
  close(runId: string, reason: string): Promise<void>;
  tryCloseForCompletion(runId: string): Promise<boolean>;
  dismissObservations(runId: string, reason: string): Promise<void>;
  setMessageCommitObserver(observer: (message: MessageWithParts) => void): void;
  subscribe(runId: string, wake: () => void): () => void;
}
export class CurrentRunInputConflictError extends Error {
  readonly code = "CURRENT_RUN_INPUT_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "CurrentRunInputConflictError";
  }
}
function conflict(message: string): never {
  throw new CurrentRunInputConflictError(message);
}
function required(value: string): void {
  if (!value.trim()) conflict("Input identity must not be empty");
}
function pending(record: CurrentRunInputRecord): boolean {
  return (
    record.closedAt === undefined && record.processedRequestId === undefined
  );
}
abstract class CurrentInputs implements CurrentRunInputStore {
  protected readonly locallyClosed = new Set<string>();
  private messageObserver: ((message: MessageWithParts) => void) | undefined;
  setMessageCommitObserver(
    observer: (message: MessageWithParts) => void,
  ): void {
    this.messageObserver = observer;
  }
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(protected readonly now: () => number = Date.now) {}
  protected abstract transaction<T>(operation: () => T): Promise<T>;
  protected abstract run(runId: string): RunLedgerRecord | undefined;
  protected abstract closeRun(runId: string, reason: string, at: number): void;
  protected abstract sealSteerRun(runId: string, at: number): void;
  protected abstract readInput(id: string): CurrentRunInputRecord | undefined;
  protected abstract inputs(runId: string): readonly CurrentRunInputRecord[];
  protected abstract saveInput(record: CurrentRunInputRecord): void;
  protected abstract readMessage(id: string): MessageWithParts | undefined;
  protected abstract putMessage(message: MessageWithParts): void;
  protected abstract prompt(id: string): PromptSubmissionRecord | undefined;
  protected abstract promptBySteerRequest(
    scope: string,
    request: string,
  ): PromptSubmissionRecord | undefined;
  protected abstract putPrompt(prompt: PromptSubmissionRecord): void;
  protected abstract requestMessage(
    requestId: string,
  ): MessageWithParts | undefined;
  protected abstract indexRequest(requestId: string, messageId: string): void;
  protected effectiveInput(
    record: CurrentRunInputRecord,
  ): CurrentRunInputRecord {
    const run = this.run(record.runId);
    return record.closedAt === undefined && run?.inputsClosedAt !== undefined
      ? {
          ...record,
          closedAt: run.inputsClosedAt,
          closeReason: run.inputsCloseReason ?? run.status,
        }
      : record;
  }
  private active(
    runId: string,
    sessionId?: string,
    scope?: string,
  ): RunLedgerRecord {
    const run = this.run(runId);
    if (
      run?.status !== "running" ||
      run.inputsClosedAt !== undefined ||
      this.locallyClosed.has(runId)
    )
      conflict("Target run is closed or not active");
    if (
      sessionId !== undefined &&
      (run.sessionId !== sessionId || run.contextScopeId !== scope)
    )
      conflict("Target run scope conflict");
    return run;
  }
  private prepareMessage(input: AcceptRuntimeInput): MessageWithParts {
    const message = structuredClone(input.message);
    if (
      message.info.id.trim() === "" ||
      message.info.role !== "user" ||
      message.info.sessionId !== input.sessionId ||
      message.info.contextScopeId !== input.contextScopeId
    )
      conflict("Input message scope conflict");
    const text = message.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    if (
      !text.trim() ||
      message.parts.some(
        (p) =>
          p.messageId !== message.info.id ||
          p.sessionId !== input.sessionId ||
          p.contextScopeId !== input.contextScopeId ||
          p.type !== "text" ||
          p.time?.compacted !== undefined,
      )
    )
      conflict("Input requires complete un-compacted text parts");
    const expected: RuntimeInputOrigin = {
      kind: input.source,
      inputId: input.inputId,
      targetRunId: input.runId,
      sourceId: input.sourceId,
    };
    if (
      message.info.runtimeInput &&
      !isDeepStrictEqual(message.info.runtimeInput, expected)
    )
      conflict("Input provenance conflict");
    return {
      ...message,
      info: { ...message.info, runId: input.runId, runtimeInput: expected },
    };
  }
  private acceptSync(
    input: AcceptRuntimeInput,
    acceptedAt = this.now(),
  ): CurrentRunInputRecord {
    for (const id of [
      input.inputId,
      input.runId,
      input.sessionId,
      input.sourceId,
    ])
      required(id);
    let message = this.prepareMessage(input);
    const old = this.readInput(input.inputId);
    if (old) {
      if (
        old.runId !== input.runId ||
        old.sessionId !== input.sessionId ||
        old.contextScopeId !== input.contextScopeId ||
        old.source !== input.source ||
        old.sourceId !== input.sourceId ||
        old.messageId !== message.info.id
      )
        conflict("Input idempotency conflict");
      const saved = this.readMessage(old.messageId);
      if (!saved || !isDeepStrictEqual(saved.parts, message.parts))
        conflict("Input content conflict");
      return old;
    }
    this.active(input.runId, input.sessionId, input.contextScopeId);
    if (
      this.inputs(input.runId).some(
        (r) => r.source === input.source && r.sourceId === input.sourceId,
      )
    )
      conflict("Input source conflict");
    const existing = this.readMessage(message.info.id);
    if (existing) {
      if (
        existing.info.sessionId !== input.sessionId ||
        existing.info.contextScopeId !== input.contextScopeId ||
        existing.info.role !== "user" ||
        (existing.info.runtimeInput &&
          !isDeepStrictEqual(
            existing.info.runtimeInput,
            message.info.runtimeInput,
          )) ||
        existing.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("") !==
          message.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("")
      )
        conflict("Existing message identity/content conflict");
      // An already persisted reserved ID keeps its original text part identities.
      message = { ...message, parts: existing.parts };
    }
    const record: CurrentRunInputRecord = {
      inputId: input.inputId,
      runId: input.runId,
      sessionId: input.sessionId,
      contextScopeId: input.contextScopeId,
      source: input.source,
      sourceId: input.sourceId,
      messageId: message.info.id,
      acceptedAt,
      ...(input.observation ? { observation: input.observation } : {}),
    };
    this.putMessage(message);
    this.saveInput(record);
    return record;
  }
  async acceptRuntimeInput(
    input: AcceptRuntimeInput,
  ): Promise<CurrentRunInputRecord> {
    const { result, created } = await this.transaction(() => {
      const created = !this.readInput(input.inputId);
      return { result: this.acceptSync(input), created };
    });
    this.messageObserver?.(this.readMessage(result.messageId) ?? input.message);
    if (created) this.wake(input.runId);
    return result;
  }
  async steerQueued(
    input: SteerQueuedPromptInput,
  ): Promise<SteerQueuedPromptResult> {
    required(input.clientRequestId);
    const result = await this.transaction(() => {
      const previous = this.promptBySteerRequest(
        input.scopeKey,
        input.clientRequestId,
      );
      if (previous) {
        const receipt = previous.steerReceipt;
        if (
          !receipt ||
          previous.promptId !== input.promptId ||
          previous.sessionId !== input.sessionId ||
          receipt.acceptedTargetRunId !== input.expectedRunId
        )
          conflict("Steer idempotency conflict");
        const message = this.readMessage(previous.userMessageId);
        if (!message || message.info.contextScopeId !== input.contextScopeId)
          conflict("Steer message conflict");
        return { receipt, prompt: previous, message };
      }
      const prompt = this.prompt(input.promptId);
      if (
        prompt?.scopeKey !== input.scopeKey ||
        prompt.sessionId !== input.sessionId ||
        prompt.status !== "queued"
      )
        conflict("Queued prompt scope or status conflict");
      if ((prompt.editLeaseExpiresAt ?? 0) > this.now())
        conflict("Queued prompt edit lease is active");
      const target = this.active(
        input.expectedRunId,
        input.sessionId,
        input.contextScopeId,
      );
      if (target.steerClosedAt !== undefined)
        conflict("Target run is already on its final step");
      const inputId = `steer:${prompt.promptId}`;
      const acceptedAt = this.now();
      const message: MessageWithParts = {
        info: {
          id: prompt.userMessageId,
          sessionId: prompt.sessionId,
          contextScopeId: input.contextScopeId,
          role: "user",
          agent: input.agent ?? "default",
          time: { created: acceptedAt, updated: acceptedAt },
        },
        parts: [
          {
            id: `${prompt.userMessageId}:steer-text`,
            messageId: prompt.userMessageId,
            sessionId: prompt.sessionId,
            contextScopeId: input.contextScopeId,
            orderIndex: 0,
            type: "text",
            text: prompt.text,
          },
        ],
      };
      const accepted = this.acceptSync(
        {
          inputId,
          runId: input.expectedRunId,
          sessionId: input.sessionId,
          contextScopeId: input.contextScopeId,
          source: "user-steer",
          sourceId: prompt.promptId,
          message,
        },
        acceptedAt,
      );
      const receipt: SteerQueuedPromptReceipt = {
        promptId: prompt.promptId,
        userMessageId: prompt.userMessageId,
        inputId,
        acceptedTargetRunId: input.expectedRunId,
        acceptedAt: accepted.acceptedAt,
        clientRequestId: input.clientRequestId,
      };
      const converted: PromptSubmissionRecord = {
        ...prompt,
        status: "steered",
        steerReceipt: receipt,
        editLeaseId: undefined,
        editLeaseOwnerId: undefined,
        editLeaseExpiresAt: undefined,
        updatedAt: accepted.acceptedAt,
        endedAt: accepted.acceptedAt,
      };
      this.putPrompt(converted);
      return {
        receipt,
        prompt: converted,
        message: this.readMessage(prompt.userMessageId) ?? message,
      };
    });
    this.messageObserver?.(result.message);
    this.wake(input.expectedRunId);
    return result;
  }
  async getInput(inputId: string): Promise<CurrentRunInputRecord | undefined> {
    return this.readInput(inputId);
  }
  async hasUnsentSteer(runId: string): Promise<boolean> {
    return this.inputs(runId).some(
      (record) =>
        record.source === "user-steer" &&
        record.closedAt !== undefined &&
        record.firstAttemptRequestId === undefined &&
        record.firstAttemptAt === undefined &&
        record.processedRequestId === undefined,
    );
  }
  async listPending(runId: string): Promise<readonly CurrentRunInputRecord[]> {
    return this.inputs(runId).filter(pending);
  }
  async getMessages(runId: string): Promise<readonly MessageWithParts[]> {
    return this.inputs(runId)
      .filter(pending)
      .map((r) => {
        const m = this.readMessage(r.messageId);
        if (!m) throw new Error("Persisted input message missing");
        return m;
      });
  }
  async filterModelHistory(
    messages: readonly MessageWithParts[],
  ): Promise<readonly MessageWithParts[]> {
    return messages.filter((m) => {
      const origin = m.info.runtimeInput;
      if (!origin) return true;
      const input = this.readInput(origin.inputId);
      if (input?.messageId !== m.info.id || input.runId !== origin.targetRunId)
        return false;
      return (
        input.processedRequestId !== undefined ||
        (input.closedAt !== undefined &&
          input.firstAttemptRequestId !== undefined)
      );
    });
  }
  async admitRequestAttempt(
    request: ModelRequestRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.transaction(() => {
      signal?.throwIfAborted();
      this.active(request.runId);
      const owner = this.readMessage(request.messageId);
      if (
        owner?.info.role !== "assistant" ||
        owner.info.runId !== request.runId
      )
        conflict("Request message owner conflict");
      const ids = [...(request.inputIds ?? [])];
      if (new Set(ids).size !== ids.length)
        conflict("Duplicate request input membership");
      const records = ids.map((id) => {
        const r = this.readInput(id);
        if (r?.runId !== request.runId || r.closedAt !== undefined)
          conflict("Request input is closed or belongs to another run");
        return r;
      });
      // A prepared wait observation cannot race ahead of newly accepted business input.
      if (
        records.some(
          (record) =>
            record.source === "subagent-status" &&
            record.firstAttemptRequestId === undefined,
        ) &&
        this.inputs(request.runId).some(
          (record) =>
            pending(record) &&
            record.source !== "subagent-status" &&
            !ids.includes(record.inputId),
        )
      ) {
        throw new RuntimeInputSnapshotChangedError();
      }
      const existingOwner = this.requestMessage(request.requestId);
      if (existingOwner && existingOwner.info.id !== owner.info.id)
        conflict("Request identity owner conflict");
      this.indexRequest(request.requestId, owner.info.id);
      const previous = owner.info.modelRequests?.find(
        (r) => r.requestId === request.requestId,
      );
      if (previous && !isDeepStrictEqual(previous.inputIds ?? [], ids))
        conflict("Immutable request membership conflict");
      const at = this.now();
      this.putMessage({
        ...owner,
        info: applyMessagePatch(owner.info, {
          modelRequests: [{ ...request, inputIds: ids }],
        }),
      });
      for (const r of records)
        if (r.firstAttemptRequestId === undefined)
          this.saveInput({
            ...r,
            firstAttemptRequestId: request.requestId,
            firstAttemptAt: at,
          });
    });
  }
  async confirmRequestSuccess(requestId: string): Promise<readonly string[]> {
    const result = await this.transaction(() => {
      const owner = this.requestMessage(requestId);
      if (owner?.info.role !== "assistant")
        conflict("Request attempt not found");
      const request = owner.info.modelRequests?.find(
        (r) => r.requestId === requestId,
      );
      if (!request) conflict("Request attempt not found");
      if (request.outcome !== "success")
        conflict("Only a persisted successful request can confirm processing");
      const records = (request.inputIds ?? []).map((id) => {
        const r = this.readInput(id);
        if (r?.runId !== request.runId || !r.firstAttemptRequestId)
          conflict("Request input owner conflict");
        return r;
      });
      const at = this.now();
      const processed: string[] = [];
      for (const r of records)
        if (!r.processedRequestId) {
          this.saveInput({
            ...r,
            processedRequestId: requestId,
            processedAt: at,
          });
          processed.push(r.inputId);
        }
      return { runId: request.runId, processed };
    });
    this.wake(result.runId);
    return result.processed;
  }
  close(runId: string, reason: string): Promise<void> {
    this.locallyClosed.add(runId);
    return this.transaction(() => {
      const at = this.now();
      this.closeRun(runId, reason, at);
      for (const r of this.inputs(runId))
        if (r.closedAt === undefined)
          this.saveInput({ ...r, closedAt: at, closeReason: reason });
    }).then(() => {
      this.wake(runId);
    });
  }
  async sealSteer(runId: string): Promise<void> {
    await this.transaction(() => {
      this.active(runId);
      this.sealSteerRun(runId, this.now());
    });
  }
  async tryCloseForCompletion(runId: string): Promise<boolean> {
    return this.transaction(() => {
      if (
        this.locallyClosed.has(runId) ||
        this.run(runId)?.inputsClosedAt !== undefined
      )
        return true;
      this.active(runId);
      if (this.inputs(runId).some(pending)) return false;
      this.closeRun(runId, "completed", this.now());
      this.locallyClosed.add(runId);
      return true;
    });
  }
  async dismissObservations(runId: string, reason: string): Promise<void> {
    const changed = await this.transaction(() => {
      let changed = false;
      for (const r of this.inputs(runId))
        if (
          r.source === "subagent-status" &&
          r.firstAttemptRequestId === undefined &&
          r.closedAt === undefined
        ) {
          this.saveInput({ ...r, closedAt: this.now(), closeReason: reason });
          changed = true;
        }
      return changed;
    });
    if (changed) this.wake(runId);
  }
  subscribe(runId: string, wake: () => void): () => void {
    const entries = this.listeners.get(runId) ?? new Set();
    entries.add(wake);
    this.listeners.set(runId, entries);
    return () => {
      entries.delete(wake);
      if (entries.size === 0) this.listeners.delete(runId);
    };
  }
  private wake(runId: string): void {
    for (const wake of this.listeners.get(runId) ?? [])
      try {
        wake();
      } catch {
        /* Durable input is authoritative; observers cannot roll back acceptance. */
      }
  }
}

export class InMemoryCurrentRunInputStore extends CurrentInputs {
  private readonly records = new Map<string, CurrentRunInputRecord>();
  private readonly requestOwners = new Map<string, string>();
  constructor(
    private readonly options: {
      runLedger: RunLedger;
      promptStore: InMemoryPromptSubmissionStore;
      messageManager: MessageManager;
      now?: () => number;
    },
  ) {
    super(options.now);
    if (
      !options.runLedger.runtimeInputMemory ||
      !options.messageManager.runtimeInputMemory
    )
      throw new Error(
        "Current-run input memory store requires shared ledger/message memory state",
      );
  }
  protected async transaction<T>(operation: () => T): Promise<T> {
    return operation();
  }
  protected run(id: string): RunLedgerRecord | undefined {
    return this.options.runLedger.runtimeInputMemory?.get(id);
  }
  protected closeRun(id: string, reason: string, at: number): void {
    this.options.runLedger.runtimeInputMemory?.close(id, reason, at);
  }
  protected sealSteerRun(id: string, at: number): void {
    this.options.runLedger.runtimeInputMemory?.sealSteer(id, at);
  }
  protected readInput(id: string): CurrentRunInputRecord | undefined {
    const r = this.records.get(id);
    return r ? this.effectiveInput(structuredClone(r)) : undefined;
  }
  protected inputs(run: string): readonly CurrentRunInputRecord[] {
    return [...this.records.values()]
      .filter((r) => r.runId === run)
      .sort(
        (a, b) =>
          a.acceptedAt - b.acceptedAt || a.inputId.localeCompare(b.inputId),
      )
      .map((r) => this.effectiveInput(structuredClone(r)));
  }
  protected saveInput(r: CurrentRunInputRecord): void {
    this.records.set(r.inputId, structuredClone(r));
  }
  protected readMessage(id: string): MessageWithParts | undefined {
    return this.options.messageManager.runtimeInputMemory?.get(id);
  }
  protected putMessage(m: MessageWithParts): void {
    this.options.messageManager.runtimeInputMemory?.put(m);
    if (m.info.role === "assistant")
      for (const r of m.info.modelRequests ?? [])
        this.requestOwners.set(r.requestId, m.info.id);
  }
  protected prompt(id: string): PromptSubmissionRecord | undefined {
    return this.options.promptStore.runtimeInputMemory.get(id);
  }
  protected promptBySteerRequest(
    scope: string,
    request: string,
  ): PromptSubmissionRecord | undefined {
    return this.options.promptStore.runtimeInputMemory
      .all()
      .find(
        (p) =>
          p.scopeKey === scope && p.steerReceipt?.clientRequestId === request,
      );
  }
  protected putPrompt(prompt: PromptSubmissionRecord): void {
    this.options.promptStore.runtimeInputMemory.put(prompt);
  }
  protected requestMessage(id: string): MessageWithParts | undefined {
    const owner = this.requestOwners.get(id);
    return owner ? this.readMessage(owner) : undefined;
  }
  protected indexRequest(id: string, messageId: string): void {
    this.requestOwners.set(id, messageId);
  }
}

export class DatabaseCurrentRunInputStore extends CurrentInputs {
  private readonly db: DatabaseConnection;
  constructor(options: { db?: DatabaseConnection; now?: () => number } = {}) {
    super(options.now);
    this.db = options.db ?? getDatabase();
  }
  protected transaction<T>(operation: () => T): Promise<T> {
    return runWriteTransaction(this.db, operation);
  }
  protected run(id: string): RunLedgerRecord | undefined {
    const r = this.db
      .prepare<{
        run_id: string;
        session_id: string;
        context_scope_id: string | null;
        status: RunLedgerRecord["status"];
        inputs_closed_at: number | null;
        steer_closed_at: number | null;
        inputs_close_reason: string | null;
      }>("SELECT * FROM run_ledger WHERE run_id=?")
      .get(id);
    return r
      ? {
          runId: r.run_id,
          sessionId: r.session_id,
          contextScopeId: r.context_scope_id ?? undefined,
          status: r.status,
          triggerSource: "user",
          createdAt: 0,
          inputsClosedAt: r.inputs_closed_at ?? undefined,
          steerClosedAt: r.steer_closed_at ?? undefined,
          inputsCloseReason: r.inputs_close_reason ?? undefined,
        }
      : undefined;
  }
  protected closeRun(id: string, reason: string, at: number): void {
    this.db
      .prepare(
        "UPDATE run_ledger SET inputs_closed_at=COALESCE(inputs_closed_at,?),inputs_close_reason=COALESCE(inputs_close_reason,?) WHERE run_id=?",
      )
      .run(at, reason, id);
  }
  protected sealSteerRun(id: string, at: number): void {
    this.db
      .prepare(
        "UPDATE run_ledger SET steer_closed_at=COALESCE(steer_closed_at,?) WHERE run_id=?",
      )
      .run(at, id);
  }
  protected readInput(id: string): CurrentRunInputRecord | undefined {
    const r = this.db
      .prepare<{
        data: string;
      }>("SELECT data FROM current_run_input WHERE input_id=?")
      .get(id);
    return r
      ? this.effectiveInput(JSON.parse(r.data) as CurrentRunInputRecord)
      : undefined;
  }
  protected inputs(run: string): readonly CurrentRunInputRecord[] {
    return this.db
      .prepare<{ data: string }>(
        "SELECT data FROM current_run_input WHERE run_id=? ORDER BY accepted_at,input_id",
      )
      .all(run)
      .map((r) =>
        this.effectiveInput(JSON.parse(r.data) as CurrentRunInputRecord),
      );
  }
  protected saveInput(r: CurrentRunInputRecord): void {
    this.db
      .prepare(
        "INSERT INTO current_run_input(input_id,run_id,session_id,source,source_id,message_id,accepted_at,data) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(input_id) DO UPDATE SET data=excluded.data",
      )
      .run(
        r.inputId,
        r.runId,
        r.sessionId,
        r.source,
        r.sourceId,
        r.messageId,
        r.acceptedAt,
        JSON.stringify(r),
      );
  }
  protected readMessage(id: string): MessageWithParts | undefined {
    const r = this.db
      .prepare<{ data: string }>("SELECT data FROM message WHERE id=?")
      .get(id);
    if (!r) return undefined;
    return {
      info: JSON.parse(r.data) as Message,
      parts: this.db
        .prepare<{ data: string }>(
          "SELECT data FROM part WHERE message_id=? ORDER BY order_index",
        )
        .all(id)
        .map((p) => JSON.parse(p.data) as Part),
    };
  }
  protected putMessage(m: MessageWithParts): void {
    const info = m.info;
    this.db
      .prepare(
        "INSERT INTO message(id,session_id,context_scope_id,role,agent,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
      )
      .run(
        info.id,
        info.sessionId,
        info.contextScopeId ?? null,
        info.role,
        "agent" in info ? (info.agent ?? null) : null,
        info.time.created,
        info.time.updated ?? info.time.created,
        JSON.stringify(info),
      );
    for (const part of m.parts) {
      const old = this.db
        .prepare<{
          message_id: string;
        }>("SELECT message_id FROM part WHERE id=?")
        .get(part.id);
      if (old && old.message_id !== info.id)
        conflict("Input text part identity conflict");
      this.db
        .prepare(
          "INSERT INTO part(id,message_id,session_id,type,order_index,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(
          part.id,
          info.id,
          info.sessionId,
          part.type,
          part.orderIndex,
          info.time.created,
          info.time.updated ?? info.time.created,
          JSON.stringify(part),
        );
    }
  }
  protected prompt(id: string): PromptSubmissionRecord | undefined {
    const r = this.db
      .prepare<PromptSubmissionRow>(
        "SELECT * FROM prompt_submission WHERE prompt_id=?",
      )
      .get(id);
    return r ? promptSubmissionRowToRecord(r) : undefined;
  }
  protected promptBySteerRequest(
    scope: string,
    request: string,
  ): PromptSubmissionRecord | undefined {
    const r = this.db
      .prepare<PromptSubmissionRow>(
        "SELECT * FROM prompt_submission WHERE scope_key=? AND json_extract(steer_receipt,'$.clientRequestId')=?",
      )
      .get(scope, request);
    return r ? promptSubmissionRowToRecord(r) : undefined;
  }
  protected putPrompt(p: PromptSubmissionRecord): void {
    const changes = this.db
      .prepare(
        "UPDATE prompt_submission SET status='steered',steer_receipt=?,updated_at=?,ended_at=?,edit_lease_id=NULL,edit_lease_owner_id=NULL,edit_lease_expires_at=NULL WHERE prompt_id=? AND status='queued'",
      )
      .run(
        JSON.stringify(p.steerReceipt),
        p.updatedAt,
        p.endedAt ?? null,
        p.promptId,
      );
    if (changes.changes !== 1) conflict("Queued prompt conversion conflict");
  }
  protected requestMessage(id: string): MessageWithParts | undefined {
    const r = this.db
      .prepare<{
        id: string;
      }>(
        "SELECT message_id AS id FROM current_run_request_owner WHERE request_id=?",
      )
      .get(id);
    return r ? this.readMessage(r.id) : undefined;
  }
  protected indexRequest(id: string, messageId: string): void {
    this.db
      .prepare(
        "INSERT INTO current_run_request_owner(request_id,message_id) VALUES(?,?) ON CONFLICT(request_id) DO NOTHING",
      )
      .run(id, messageId);
  }
}
