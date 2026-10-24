import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiPermissionBinding,
  UiPromptReceipt,
} from "ohbaby-sdk";
import type { ClientSync } from "./client-sync.js";
import type { UnknownPromptRequest } from "./wire.js";

/** Rejections that prove the server never admitted the prompt. */
const KNOWN_REJECTION_CODES = [
  "QUEUE_FULL",
  "INVALID_CLIENT_REQUEST_ID",
  "PROMPT_SCHEDULER_CLOSED",
  "IDEMPOTENCY_CONFLICT",
  "PROMPT_SUBMISSION_REJECTED",
];

/**
 * Prompt submission, queued-prompt edits and the ledger of prompts whose
 * admission is unknown. The ledger survives reloads so an unconfirmed prompt
 * is never resent blindly.
 */
export class ClientPrompts {
  private unknownPrompts: UnknownPromptRequest[];
  private readonly submittingPrompts = new Set<string>();
  private persistedUnknownIds: Set<string>;
  private receiptTicket = 0;

  constructor(private readonly sync: ClientSync) {
    this.unknownPrompts = readUnknownPrompts(this.directory);
    this.persistedUnknownIds = new Set(
      this.unknownPrompts.map((request) => request.clientRequestId),
    );
    this.sync.store.setUnknownPromptRequests(this.unknownPrompts);
  }

  private get directory(): string {
    return this.sync.config.directory ?? "";
  }

  isUnknown(clientRequestId: string): boolean {
    return this.unknownPrompts.some(
      (request) => request.clientRequestId === clientRequestId,
    );
  }

  hasUnknownForSession(sessionId: string | undefined): boolean {
    return this.unknownPrompts.some(
      (request) =>
        request.sessionId === sessionId && request.status !== "epoch-changed",
    );
  }

  /** Records an in-flight request as unknown until its outcome is proven. */
  track(
    binding: UiPermissionBinding,
    clientRequestId: string,
    sessionId: string | undefined,
  ): void {
    this.submittingPrompts.add(clientRequestId);
    this.unknownPrompts = [
      ...this.unknownPrompts,
      {
        directory: this.directory,
        runtimeEpoch: binding.permissionEpoch,
        clientRequestId,
        sessionId,
        status: "unknown",
      },
    ];
    this.publish();
  }

  /** The outcome is known (admitted or rejected): drop the record. */
  resolve(clientRequestId: string): void {
    this.unknownPrompts = this.unknownPrompts.filter(
      (request) => request.clientRequestId !== clientRequestId,
    );
    this.publish();
  }

  /** The request is no longer in flight; an unresolved record stays. */
  finish(clientRequestId: string): void {
    this.submittingPrompts.delete(clientRequestId);
    this.publish();
  }

  private publish(): void {
    writeUnknownPrompts(
      this.directory,
      this.unknownPrompts,
      this.persistedUnknownIds,
    );
    this.persistedUnknownIds = new Set(
      this.unknownPrompts.map((request) => request.clientRequestId),
    );
    if (!this.sync.closed)
      this.sync.store.setUnknownPromptRequests(
        this.unknownPrompts.map((request) => ({
          ...request,
          submitting: this.submittingPrompts.has(request.clientRequestId),
        })),
      );
  }

  forgetUnknownPrompt(clientRequestId: string): void {
    if (this.submittingPrompts.has(clientRequestId)) return;
    this.resolve(clientRequestId);
  }

  async retryUnknownPrompts(): Promise<void> {
    const binding = this.sync.binding;
    if (!binding || !this.sync.recoverySupported || this.sync.closed) return;
    const ticket = ++this.receiptTicket;
    for (const request of [...this.unknownPrompts]) {
      if (request.runtimeEpoch !== binding.permissionEpoch) {
        this.unknownPrompts = this.unknownPrompts.map((value) =>
          value.clientRequestId === request.clientRequestId
            ? { ...value, status: "epoch-changed" }
            : value,
        );
        this.publish();
        continue;
      }
      try {
        const result = (
          await this.sync.http.getPromptReceipt({
            clientRequestId: request.clientRequestId,
            sessionId: request.sessionId,
            runtimeEpoch: request.runtimeEpoch,
            bindingGeneration: binding.bindingGeneration,
            signal: this.sync.signal,
          })
        ).result;
        if (
          this.sync.signal.aborted ||
          ticket !== this.receiptTicket ||
          binding.bindingGeneration !==
            this.sync.permissionSync.getState().binding?.bindingGeneration
        )
          return;
        if (
          result.runtimeEpoch !== request.runtimeEpoch ||
          result.bindingGeneration !== binding.bindingGeneration ||
          result.clientRequestId !== request.clientRequestId
        )
          continue;
        if (result.receipt) {
          this.resolve(request.clientRequestId);
          if (this.sync.currentScope()?.sessionId === result.receipt.sessionId)
            this.sync.sessionSync.resync();
        }
      } catch {
        /* An unknown result stays unknown. Never resend or navigate. */
      }
    }
  }

  async submitPromptAccepted(
    text: string,
    options?: SubmitPromptOptions,
  ): Promise<UiPromptReceipt> {
    const binding = this.sync.binding;
    if (
      !this.sync.recoverySupported ||
      !binding ||
      (binding.rootSessionId !== null &&
        this.sync.sessionSync.getState().status !== "ready")
    )
      throw new Error("Session is not synchronized");
    const clientRequestId =
      options?.clientRequestId ?? globalThis.crypto.randomUUID();
    if (this.isUnknown(clientRequestId))
      throw new Error(
        "Prompt result is unknown; query its receipt before submitting again",
      );
    const scopeTicket = this.sync.scopeTicket;
    const sessionId = options?.sessionId ?? binding.rootSessionId ?? undefined;
    if (sessionId !== (binding.rootSessionId ?? undefined))
      throw new Error("Selected session changed before submission");
    if (this.hasUnknownForSession(sessionId))
      throw new Error(
        "A prompt result is unknown for this session; query its receipt before submitting again",
      );
    this.track(binding, clientRequestId, sessionId);
    try {
      const { ok: _ok, ...receipt } = await this.sync.http.submitPromptAccepted(
        {
          clientRequestId,
          sessionId,
          text,
          ...(options?.namingSource === undefined
            ? {}
            : { namingSource: options.namingSource }),
          ...(options?.reasoning === undefined
            ? {}
            : { reasoning: options.reasoning }),
        },
      );
      this.resolve(clientRequestId);
      if (
        !this.sync.closed &&
        scopeTicket === this.sync.scopeTicket &&
        "permissionEpoch" in receipt &&
        "rootSessionId" in receipt &&
        "bindingGeneration" in receipt
      )
        this.sync.acceptBinding(
          receipt as typeof receipt & UiPermissionBinding,
        );
      return receipt;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        KNOWN_REJECTION_CODES.includes(String(error.code))
      ) {
        this.resolve(clientRequestId);
      }
      throw error;
    } finally {
      this.finish(clientRequestId);
    }
  }

  async waitForPrompt(
    promptId: string,
    options?: Parameters<UiBackendClient["waitForPrompt"]>[1],
  ): ReturnType<UiBackendClient["waitForPrompt"]> {
    return (await this.sync.http.waitForPrompt(promptId, options)).completion;
  }

  async acquirePromptEditLease(
    input: Parameters<UiBackendClient["acquirePromptEditLease"]>[0],
  ): ReturnType<UiBackendClient["acquirePromptEditLease"]> {
    return (await this.sync.http.acquirePromptEditLease(input.promptId)).lease;
  }

  async renewPromptEditLease(
    input: Parameters<UiBackendClient["renewPromptEditLease"]>[0],
  ): ReturnType<UiBackendClient["renewPromptEditLease"]> {
    return (
      await this.sync.http.renewPromptEditLease(
        input.promptId,
        input.editLeaseId,
      )
    ).lease;
  }

  async releasePromptEditLease(
    input: Parameters<UiBackendClient["releasePromptEditLease"]>[0],
  ): ReturnType<UiBackendClient["releasePromptEditLease"]> {
    return (
      await this.sync.http.releasePromptEditLease(
        input.promptId,
        input.editLeaseId,
      )
    ).prompt;
  }

  async editQueuedPrompt(
    input: Parameters<UiBackendClient["editQueuedPrompt"]>[0],
  ): ReturnType<UiBackendClient["editQueuedPrompt"]> {
    return (
      await this.sync.http.editQueuedPrompt(
        input.promptId,
        input.editLeaseId,
        input.text,
      )
    ).prompt;
  }

  async resubmitRetainedPrompt(
    input: Parameters<UiBackendClient["resubmitRetainedPrompt"]>[0],
  ): ReturnType<UiBackendClient["resubmitRetainedPrompt"]> {
    return (await this.sync.http.resubmitRetainedPrompt(input)).receipt;
  }

  async resendSteerInput(
    input: Parameters<UiBackendClient["resendSteerInput"]>[0],
  ): ReturnType<UiBackendClient["resendSteerInput"]> {
    return (await this.sync.http.resendSteerInput(input)).receipt;
  }

  async steerQueuedPrompt(
    input: Parameters<UiBackendClient["steerQueuedPrompt"]>[0],
  ): ReturnType<UiBackendClient["steerQueuedPrompt"]> {
    return (
      await this.sync.http.steerQueuedPrompt(
        input.promptId,
        input.expectedRunId,
        input.clientRequestId,
      )
    ).result;
  }

  async cancelQueuedPrompt(
    input: Parameters<UiBackendClient["cancelQueuedPrompt"]>[0],
  ): ReturnType<UiBackendClient["cancelQueuedPrompt"]> {
    return (
      await this.sync.http.cancelQueuedPrompt(input.promptId, input.editLeaseId)
    ).prompt;
  }
}

const UNKNOWN_PROMPTS_KEY = "ohbaby.web.unknown-prompts.v1";
function readUnknownPrompts(directory: string): UnknownPromptRequest[] {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return [];
    const prefix = `${UNKNOWN_PROMPTS_KEY}:${encodeURIComponent(directory)}:`;
    const result: UnknownPromptRequest[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
      if (typeof value !== "object" || value === null) continue;
      const record = value as Partial<UnknownPromptRequest>;
      if (
        record.directory === directory &&
        typeof record.clientRequestId === "string" &&
        typeof record.runtimeEpoch === "string" &&
        (record.sessionId === undefined ||
          typeof record.sessionId === "string") &&
        (record.status === "unknown" || record.status === "epoch-changed")
      )
        result.push(record as UnknownPromptRequest);
    }
    return result;
  } catch {
    return [];
  }
}
function writeUnknownPrompts(
  directory: string,
  requests: readonly UnknownPromptRequest[],
  previousIds: ReadonlySet<string>,
): void {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return;
    const prefix = `${UNKNOWN_PROMPTS_KEY}:${encodeURIComponent(directory)}:`;
    const ids = new Set(requests.map((request) => request.clientRequestId));
    for (const id of previousIds)
      if (!ids.has(id))
        storage.removeItem(`${prefix}${encodeURIComponent(id)}`);
    for (const request of requests)
      storage.setItem(
        `${prefix}${encodeURIComponent(request.clientRequestId)}`,
        JSON.stringify(request),
      );
  } catch {
    /* The active client still retains the unresolved identity in memory. */
  }
}
