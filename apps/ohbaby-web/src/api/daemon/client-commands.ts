import {
  isUiCommandCompletion,
  type UiBackendClient,
  type UiPermissionBinding,
  type UiWebCommandCatalog,
} from "ohbaby-sdk";
import type { ClientPrompts } from "./client-prompts.js";
import type { ClientSync } from "./client-sync.js";

/**
 * Slash commands and session-level operations that are not prompts: model,
 * search key, context window, compact, reasoning, export and archive.
 */
export class ClientCommands {
  private readonly catalogPromises = new Map<
    string,
    Promise<UiWebCommandCatalog>
  >();

  constructor(
    private readonly sync: ClientSync,
    private readonly prompts: ClientPrompts,
  ) {}

  clearCatalogCache(): void {
    this.catalogPromises.clear();
  }

  async listCommands(
    query: Parameters<UiBackendClient["listCommands"]>[0],
  ): ReturnType<UiBackendClient["listCommands"]> {
    const cached = this.catalogPromises.get(query.surface);
    if (cached) return cached;
    const promise = this.sync.http
      .listCommands(query.surface)
      .then((response) => response.catalog)
      .catch((error: unknown) => {
        this.catalogPromises.delete(query.surface);
        throw error;
      });
    this.catalogPromises.set(query.surface, promise);
    return promise;
  }

  listWebCommands(): Promise<UiWebCommandCatalog> {
    return this.listCommands({
      surface: "web",
    }) as Promise<UiWebCommandCatalog>;
  }

  async executeCommand(
    invocation: Parameters<UiBackendClient["executeCommand"]>[0],
    options?: Parameters<UiBackendClient["executeCommand"]>[1],
  ): ReturnType<UiBackendClient["executeCommand"]> {
    const { store } = this.sync;
    // Retain this invocation's feedback through the bounded store timeout;
    // removing its presentation/correlation must not erase an observed failure.
    const feedback = store.getCommandFeedback(invocation.clientInvocationId);
    const binding = this.sync.binding;
    const skill = invocation.commandId.startsWith("skill.");
    const clientRequestId = skill
      ? (invocation.clientRequestId ?? globalThis.crypto.randomUUID())
      : undefined;
    const scopeTicket = this.sync.scopeTicket;
    const rejectLocally = (message: string): never => {
      store.failCommand(invocation.clientInvocationId, message);
      throw Object.assign(new Error(message), { commandFeedback: true });
    };
    if (skill && clientRequestId) {
      if (!binding || !this.sync.recoverySupported)
        return rejectLocally("Session is not synchronized");
      if (
        this.prompts.isUnknown(clientRequestId) ||
        this.prompts.hasUnknownForSession(invocation.sessionId)
      )
        rejectLocally(
          "Prompt result is unknown; query its receipt before submitting again",
        );
      this.prompts.track(binding, clientRequestId, invocation.sessionId);
    }
    try {
      const completion = await this.sync.http.executeCommand(
        { ...invocation, ...(clientRequestId ? { clientRequestId } : {}) },
        AbortSignal.any([
          this.sync.signal,
          AbortSignal.timeout(60_000),
          ...(options?.signal ? [options.signal] : []),
        ]),
      );
      if (
        !isUiCommandCompletion(completion) ||
        completion.clientInvocationId !== invocation.clientInvocationId ||
        (!skill && completion.promptReceipt !== undefined)
      )
        throw new Error(
          "server did not return a valid completion. Check its effects before running it again.",
        );
      if (
        skill &&
        completion.status === "completed" &&
        completion.promptReceipt?.clientRequestId !== clientRequestId
      )
        throw new Error(
          "Accepted skill receipt is missing or does not match this request",
        );
      if (
        skill &&
        clientRequestId &&
        (completion.status === "failed" ||
          completion.promptReceipt?.clientRequestId === clientRequestId)
      ) {
        this.prompts.resolve(clientRequestId);
      }
      if (!this.sync.closed && scopeTicket === this.sync.scopeTicket) {
        store.completeCommand(completion);
        if (
          completion.promptReceipt &&
          "permissionEpoch" in completion &&
          "rootSessionId" in completion &&
          "bindingGeneration" in completion
        )
          this.sync.acceptBinding(
            completion as typeof completion & UiPermissionBinding,
          );
      }
      return completion;
    } catch (error) {
      if (
        options?.signal?.aborted &&
        (error instanceof Error || error instanceof DOMException) &&
        error.name === "AbortError"
      ) {
        // The HTTP response can be lost after commit; keep authoritative events.
        if (!this.sync.closed && scopeTicket === this.sync.scopeTicket)
          store.stopCommandWait(invocation.clientInvocationId);
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      const unconfirmed = `Command result is unconfirmed: ${message}`;
      const detail = feedback?.error
        ? `${feedback.error.message} — ${unconfirmed}`
        : unconfirmed;
      if (!this.sync.closed && scopeTicket === this.sync.scopeTicket)
        store.failCommand(invocation.clientInvocationId, detail);
      throw Object.assign(new Error(detail), { commandFeedback: true });
    } finally {
      if (clientRequestId) this.prompts.finish(clientRequestId);
    }
  }

  async getCurrentModel(): ReturnType<UiBackendClient["getCurrentModel"]> {
    const response = await this.sync.http.getCurrentModel();
    return response.model;
  }

  async probeModelContextWindow(
    input: Parameters<UiBackendClient["probeModelContextWindow"]>[0],
  ): ReturnType<UiBackendClient["probeModelContextWindow"]> {
    const response = await this.sync.http.probeModelContextWindow(input);
    return response.probe;
  }

  async connectModel(
    input: Parameters<UiBackendClient["connectModel"]>[0],
  ): ReturnType<UiBackendClient["connectModel"]> {
    const scopeTicket = this.sync.scopeTicket;
    const ticket = this.sync.nextModelTicket();
    const response = await this.sync.http.connectModel(input);
    if (
      !this.sync.closed &&
      scopeTicket === this.sync.scopeTicket &&
      ticket === this.sync.modelTicket
    )
      this.sync.store.setCurrentModel(response.model);
    return response.model;
  }

  async setSearchApiKey(
    input: Parameters<UiBackendClient["setSearchApiKey"]>[0],
  ): ReturnType<UiBackendClient["setSearchApiKey"]> {
    const response = await this.sync.http.setSearchApiKey(input);
    return response.search;
  }

  async getContextWindowUsage(
    input: Parameters<UiBackendClient["getContextWindowUsage"]>[0],
  ): ReturnType<UiBackendClient["getContextWindowUsage"]> {
    const response = await this.sync.http.getContextWindowUsage(
      input.sessionId,
    );
    return response.usage;
  }

  async compactSession(
    options: Parameters<UiBackendClient["compactSession"]>[0] = {},
  ): ReturnType<UiBackendClient["compactSession"]> {
    const sessionId =
      options.sessionId ??
      this.sync.store.getSnapshot().view.snapshot?.activeSessionId;
    if (!sessionId) {
      throw new Error("No session is selected");
    }
    const response = await this.sync.http.compactSession(
      sessionId,
      {
        ...(options.force === undefined ? {} : { force: options.force }),
      },
      { signal: options.signal },
    );
    return response.compact;
  }

  async updateSessionReasoning(
    input: Parameters<UiBackendClient["updateSessionReasoning"]>[0],
  ): ReturnType<UiBackendClient["updateSessionReasoning"]> {
    return (await this.sync.http.updateSessionReasoning(input)).session;
  }

  async exportSession(
    input: Parameters<UiBackendClient["exportSession"]>[0],
  ): ReturnType<UiBackendClient["exportSession"]> {
    return (await this.sync.http.exportSession(input)).export;
  }

  async archiveSession(
    input: Parameters<UiBackendClient["archiveSession"]>[0],
  ): ReturnType<UiBackendClient["archiveSession"]> {
    await this.sync.http.archiveSession(input.sessionId);
    this.sync.sessionSync.resync();
    void this.sync.refreshIndex();
  }
}
