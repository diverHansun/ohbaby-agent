import {
  submitPromptAndWait as composeSubmitPromptAndWait,
  type SubmitPromptOptions,
  type UiBackendClient,
  type UiEventHandler,
  type UiPermissionEvent,
  type UiPromptCompletion,
  type UiPromptReceipt,
  type UiPromptReceiptQuery,
  type UiPromptReceiptResult,
  type UiSessionControl,
  type UiSessionHistory,
  type UiSessionScope,
  type UiSessionView,
  type UiSubagentConversationQuery,
  type UiSubagentConversationSelection,
  type UiSubagentConversationUnwatchQuery,
  type UiSubagentConversationView,
  type UiSubagentExecutionList,
  type UiSubagentExecutionView,
  type UiSubagentInstanceQuery,
  type UiSubagentInstanceSnapshot,
  type UiSubagentQuery,
  type UiSubagentStopInput,
  type UiSubagentStopResult,
  type UiUnsubscribe,
  type UiWebCommandCatalog,
} from "ohbaby-sdk";
import type { OhbabyWebStore } from "../../store/store.js";
import { ClientCommands } from "./client-commands.js";
import { ClientPrompts } from "./client-prompts.js";
import { ClientSync } from "./client-sync.js";
import { FetchDaemonEventStream } from "./events.js";
import { createDaemonHttpClient, type DaemonHttpClient } from "./http.js";
import type { OhbabyBootstrapConfig } from "./wire.js";

/**
 * The instance client for one directory. It assembles the sync core
 * (`client-sync`), prompt ledger (`client-prompts`) and commands
 * (`client-commands`) behind `UiBackendClient`; approvals, aborts and
 * subagent queries stay here because they only read the binding.
 */
export class BrowserDaemonClient implements UiBackendClient {
  private readonly http: DaemonHttpClient;
  private readonly sync: ClientSync;
  private readonly prompts: ClientPrompts;
  private readonly commands: ClientCommands;
  private subagentWatchSequence = 0;

  constructor(input: {
    readonly config: OhbabyBootstrapConfig;
    readonly events: FetchDaemonEventStream;
    readonly http: DaemonHttpClient;
    readonly store: OhbabyWebStore;
  }) {
    this.http = input.http;
    this.sync = new ClientSync({
      ...input,
      hooks: {
        onScopeReady: (): void => {
          void this.prompts.retryUnknownPrompts();
        },
        onCommandCatalogUpdated: (): void => {
          this.commands.clearCatalogCache();
        },
      },
    });
    this.prompts = new ClientPrompts(this.sync);
    this.commands = new ClientCommands(this.sync, this.prompts);
  }

  connect(): Promise<void> {
    return this.sync.connect();
  }

  get closed(): boolean {
    return this.sync.closed;
  }

  close(): Promise<void> {
    return this.sync.close();
  }

  retrySession(): void {
    this.sync.retrySession();
  }

  loadEarlierHistory(): Promise<void> {
    return this.sync.loadEarlierHistory();
  }

  retryPermissions(): void {
    this.sync.permissionSync.retry();
  }

  forgetUnknownPrompt(clientRequestId: string): void {
    this.prompts.forgetUnknownPrompt(clientRequestId);
  }

  hasUnknownPrompt(clientRequestId: string): boolean {
    return this.prompts.isUnknown(clientRequestId);
  }

  retryUnknownPrompts(): Promise<void> {
    return this.prompts.retryUnknownPrompts();
  }

  async listSubagentExecutions(
    input: UiSubagentQuery,
  ): Promise<UiSubagentExecutionList> {
    const binding = this.sync.permissionSync.getState().binding;
    const result = await this.http.listSubagentExecutions({
      ...input,
      runtimeEpoch: binding?.permissionEpoch,
      bindingGeneration: binding?.bindingGeneration,
    });
    if (binding !== this.sync.permissionSync.getState().binding)
      throw new Error("Session binding changed during execution query");
    return result.result;
  }
  async getSubagentExecutionView(
    input: UiSubagentQuery & { executionId: string },
  ): Promise<UiSubagentExecutionView> {
    const binding = this.sync.permissionSync.getState().binding;
    const result = await this.http.getSubagentExecutionView({
      ...input,
      runtimeEpoch: binding?.permissionEpoch,
      bindingGeneration: binding?.bindingGeneration,
    });
    if (binding !== this.sync.permissionSync.getState().binding)
      throw new Error("Session binding changed during execution query");
    return result.result;
  }
  async getSubagentConversationView(
    input: UiSubagentConversationQuery,
  ): Promise<UiSubagentConversationView> {
    if (!this.sync.subagentConversationSupported)
      throw new Error("Server does not support subagent conversations");
    const binding = this.sync.permissionSync.getState().binding;
    const result = await this.http.getSubagentConversationView({
      ...input,
      runtimeEpoch: binding?.permissionEpoch,
      bindingGeneration: binding?.bindingGeneration,
    });
    if (binding !== this.sync.permissionSync.getState().binding)
      throw new Error("Session binding changed during conversation query");
    return result.result;
  }
  async watchSubagentConversation(
    input: UiSubagentConversationQuery,
  ): Promise<UiSubagentConversationSelection> {
    const watchSequence = ++this.subagentWatchSequence;
    if (!this.sync.subagentConversationSupported)
      throw new Error("Server does not support subagent conversations");
    const binding = this.sync.permissionSync.getState().binding;
    const result = await this.http.watchSubagentConversation({
      ...input,
      watchSequence,
      runtimeEpoch: binding?.permissionEpoch,
      bindingGeneration: binding?.bindingGeneration,
    });
    if (binding !== this.sync.permissionSync.getState().binding)
      throw new Error("Session binding changed during conversation watch");
    return result.result;
  }
  async unwatchSubagentConversation(
    input: UiSubagentConversationUnwatchQuery,
  ): Promise<void> {
    const binding = this.sync.permissionSync.getState().binding;
    await this.http.unwatchSubagentConversation({
      ...input,
      runtimeEpoch: input.runtimeEpoch ?? binding?.permissionEpoch,
      bindingGeneration: input.bindingGeneration ?? binding?.bindingGeneration,
    });
  }
  async listSubagentInstances(
    input: UiSubagentInstanceQuery,
  ): Promise<UiSubagentInstanceSnapshot> {
    const binding = this.sync.permissionSync.getState().binding;
    const result = await this.http.listSubagentInstances({
      ...input,
      runtimeEpoch: binding?.permissionEpoch,
      bindingGeneration: binding?.bindingGeneration,
    });
    if (binding !== this.sync.permissionSync.getState().binding)
      throw new Error("Session binding changed during instance query");
    return result.result;
  }
  /** A stop may already have happened when the binding moves on; the receipt stands. */
  async stopSubagent(
    input: UiSubagentStopInput,
  ): Promise<UiSubagentStopResult> {
    const binding = this.sync.permissionSync.getState().binding;
    return (
      await this.http.stopSubagent({
        ...input,
        runtimeEpoch: binding?.permissionEpoch,
        bindingGeneration: binding?.bindingGeneration,
      })
    ).result;
  }
  async getSessionView(input: UiSessionScope): Promise<UiSessionView> {
    return (await this.http.getSessionView(input)).view;
  }
  async getSessionHistory(
    input: UiSessionScope & {
      readonly before?: string;
      readonly limit?: number;
    },
  ): Promise<UiSessionHistory> {
    return (await this.http.getSessionHistory(input)).history;
  }
  async getSessionControl(input: UiSessionScope): Promise<UiSessionControl> {
    return (await this.http.getSessionControl(input)).control;
  }
  async getPromptReceipt(
    input: UiPromptReceiptQuery,
  ): Promise<UiPromptReceiptResult> {
    return (await this.http.getPromptReceipt(input)).result;
  }

  getSelectedSessionId(): ReturnType<UiBackendClient["getSelectedSessionId"]> {
    return Promise.resolve(this.sync.binding?.rootSessionId ?? null);
  }

  createSession(
    input?: Parameters<UiBackendClient["createSession"]>[0],
  ): ReturnType<UiBackendClient["createSession"]> {
    return this.sync.createSession(input);
  }

  selectSession(
    sessionId: string,
  ): ReturnType<UiBackendClient["selectSession"]> {
    return this.sync.selectSession(sessionId);
  }

  getSessionIndex(): ReturnType<UiBackendClient["getSessionIndex"]> {
    return this.sync.getSessionIndex();
  }

  async getPermissionSnapshot(
    input: Parameters<UiBackendClient["getPermissionSnapshot"]>[0],
  ): ReturnType<UiBackendClient["getPermissionSnapshot"]> {
    return (
      await this.http.getPermissionSnapshot({
        ...this.sync.permissionSync.getState().binding,
        ...input,
      })
    ).snapshot;
  }

  subscribePermissionEvents(
    handler: (event: UiPermissionEvent) => void,
    onError?: (error: unknown) => void,
  ): UiUnsubscribe {
    return this.sync.subscribePermissionEvents(handler, onError);
  }

  async getSnapshot(): ReturnType<UiBackendClient["getSnapshot"]> {
    return (await this.http.getSnapshot()).snapshot;
  }

  subscribeEvents(handler: UiEventHandler): UiUnsubscribe {
    return this.sync.subscribeEvents(handler);
  }

  submitPromptAccepted(
    text: string,
    options?: SubmitPromptOptions,
  ): Promise<UiPromptReceipt> {
    return this.prompts.submitPromptAccepted(text, options);
  }

  submitPromptAndWait(
    text: string,
    options?: Parameters<UiBackendClient["submitPromptAndWait"]>[1],
  ): Promise<UiPromptCompletion> {
    return composeSubmitPromptAndWait(this, text, options);
  }

  waitForPrompt(
    promptId: string,
    options?: Parameters<UiBackendClient["waitForPrompt"]>[1],
  ): ReturnType<UiBackendClient["waitForPrompt"]> {
    return this.prompts.waitForPrompt(promptId, options);
  }

  acquirePromptEditLease(
    input: Parameters<UiBackendClient["acquirePromptEditLease"]>[0],
  ): ReturnType<UiBackendClient["acquirePromptEditLease"]> {
    return this.prompts.acquirePromptEditLease(input);
  }

  renewPromptEditLease(
    input: Parameters<UiBackendClient["renewPromptEditLease"]>[0],
  ): ReturnType<UiBackendClient["renewPromptEditLease"]> {
    return this.prompts.renewPromptEditLease(input);
  }

  releasePromptEditLease(
    input: Parameters<UiBackendClient["releasePromptEditLease"]>[0],
  ): ReturnType<UiBackendClient["releasePromptEditLease"]> {
    return this.prompts.releasePromptEditLease(input);
  }

  editQueuedPrompt(
    input: Parameters<UiBackendClient["editQueuedPrompt"]>[0],
  ): ReturnType<UiBackendClient["editQueuedPrompt"]> {
    return this.prompts.editQueuedPrompt(input);
  }

  resubmitRetainedPrompt(
    input: Parameters<UiBackendClient["resubmitRetainedPrompt"]>[0],
  ): ReturnType<UiBackendClient["resubmitRetainedPrompt"]> {
    return this.prompts.resubmitRetainedPrompt(input);
  }

  resendSteerInput(
    input: Parameters<UiBackendClient["resendSteerInput"]>[0],
  ): ReturnType<UiBackendClient["resendSteerInput"]> {
    return this.prompts.resendSteerInput(input);
  }

  steerQueuedPrompt(
    input: Parameters<UiBackendClient["steerQueuedPrompt"]>[0],
  ): ReturnType<UiBackendClient["steerQueuedPrompt"]> {
    return this.prompts.steerQueuedPrompt(input);
  }

  cancelQueuedPrompt(
    input: Parameters<UiBackendClient["cancelQueuedPrompt"]>[0],
  ): ReturnType<UiBackendClient["cancelQueuedPrompt"]> {
    return this.prompts.cancelQueuedPrompt(input);
  }

  listCommands(
    query: Parameters<UiBackendClient["listCommands"]>[0],
  ): ReturnType<UiBackendClient["listCommands"]> {
    return this.commands.listCommands(query);
  }

  listWebCommandsForRuntime(): Promise<UiWebCommandCatalog> {
    return this.commands.listWebCommands();
  }

  getCurrentModel(
    input?: Parameters<UiBackendClient["getCurrentModel"]>[0],
  ): ReturnType<UiBackendClient["getCurrentModel"]> {
    return this.commands.getCurrentModel(input);
  }

  probeModelContextWindow(): ReturnType<
    UiBackendClient["probeModelContextWindow"]
  > {
    return this.commands.probeModelContextWindow();
  }

  connectModel(): ReturnType<UiBackendClient["connectModel"]> {
    return this.commands.connectModel();
  }

  setSearchApiKey(): ReturnType<UiBackendClient["setSearchApiKey"]> {
    return this.commands.setSearchApiKey();
  }

  getContextWindowUsage(
    input: Parameters<UiBackendClient["getContextWindowUsage"]>[0],
  ): ReturnType<UiBackendClient["getContextWindowUsage"]> {
    return this.commands.getContextWindowUsage(input);
  }

  compactSession(
    options?: Parameters<UiBackendClient["compactSession"]>[0],
  ): ReturnType<UiBackendClient["compactSession"]> {
    return this.commands.compactSession(options);
  }

  updateSessionModel(
    input: Parameters<UiBackendClient["updateSessionModel"]>[0],
  ): ReturnType<UiBackendClient["updateSessionModel"]> {
    return this.commands.updateSessionModel(input);
  }

  selectDefaultModel(
    entryId: string,
  ): ReturnType<UiBackendClient["selectDefaultModel"]> {
    return this.commands.selectDefaultModel(entryId);
  }

  updateSessionReasoning(
    input: Parameters<UiBackendClient["updateSessionReasoning"]>[0],
  ): ReturnType<UiBackendClient["updateSessionReasoning"]> {
    return this.commands.updateSessionReasoning(input);
  }

  exportSession(
    input: Parameters<UiBackendClient["exportSession"]>[0],
  ): ReturnType<UiBackendClient["exportSession"]> {
    return this.commands.exportSession(input);
  }

  archiveSession(
    input: Parameters<UiBackendClient["archiveSession"]>[0],
  ): ReturnType<UiBackendClient["archiveSession"]> {
    return this.commands.archiveSession(input);
  }

  executeCommand(
    invocation: Parameters<UiBackendClient["executeCommand"]>[0],
    options?: Parameters<UiBackendClient["executeCommand"]>[1],
  ): ReturnType<UiBackendClient["executeCommand"]> {
    return this.commands.executeCommand(invocation, options);
  }

  createSessionForRuntime(): ReturnType<UiBackendClient["createSession"]> {
    return this.createSession({
      reuseInactiveEmpty: { excludeSessionIds: [] },
    });
  }

  selectSessionForRuntime(sessionId: string): Promise<void> {
    return this.sync.selectSession(sessionId);
  }

  async respondPermission(
    requestId: string,
    response: Parameters<UiBackendClient["respondPermission"]>[1],
    context?: Parameters<UiBackendClient["respondPermission"]>[2],
  ): ReturnType<UiBackendClient["respondPermission"]> {
    const permissionSync = this.sync.permissionSync;
    const state = permissionSync.getState();
    const binding = state.binding;
    if (
      state.status !== "ready" ||
      !binding ||
      !state.requests.some((request) => request.id === requestId)
    )
      throw new Error("Approvals are not synchronized");
    if (
      context &&
      (context.permissionEpoch !== binding.permissionEpoch ||
        context.rootSessionId !== binding.rootSessionId ||
        (context.bindingGeneration !== undefined &&
          context.bindingGeneration !== binding.bindingGeneration))
    )
      throw new Error("Permission scope changed");
    try {
      await this.http.respondPermission(requestId, {
        response,
        context: binding,
      });
    } catch (error) {
      const latest = permissionSync.getState().binding;
      if (
        latest?.permissionEpoch !== binding.permissionEpoch ||
        latest.rootSessionId !== binding.rootSessionId ||
        latest.bindingGeneration !== binding.bindingGeneration
      )
        return;
      if (typeof error === "object" && error !== null && "code" in error) {
        if (error.code === "PERMISSION_NOT_PENDING") {
          permissionSync.resync();
          return;
        }
        if (error.code === "PERMISSION_UNAVAILABLE")
          permissionSync.receive({
            type: "permission.unavailable",
            ...binding,
            reason:
              error instanceof Error ? error.message : "Approvals unavailable",
          });
      }
      throw error;
    }
  }

  async respondInteraction(
    interactionId: string,
    response: Parameters<UiBackendClient["respondInteraction"]>[1],
  ): ReturnType<UiBackendClient["respondInteraction"]> {
    await this.http.respondInteraction(interactionId, response);
  }

  async setPermission(
    input: Parameters<UiBackendClient["setPermission"]>[0],
  ): ReturnType<UiBackendClient["setPermission"]> {
    const scope = this.sync.scopeTicket;
    const { permission } = await this.http.setPermission(input);
    if (!this.sync.closed && scope === this.sync.scopeTicket)
      this.sync.store.setPermission(permission);
    return permission;
  }

  async abortRun(runId: string): ReturnType<UiBackendClient["abortRun"]> {
    const target = this.sync.control;
    if (target?.runId !== runId)
      throw new Error("The exact running task has not been verified");
    await this.http.abortSession(target.sessionId, {
      runId,
      runtimeEpoch: target.runtimeEpoch,
      bindingGeneration: target.bindingGeneration,
    });
    await this.sync.refreshControl();
  }
  async abortSessionForRuntime(
    sessionId: string,
    runId?: string,
  ): Promise<void> {
    const target = this.sync.control;
    if (
      target?.sessionId !== sessionId ||
      !target.runId ||
      (runId !== undefined && target.runId !== runId)
    )
      throw new Error("The exact running task has not been verified");
    await this.abortRun(target.runId);
  }
}

export function createBrowserDaemonClient(input: {
  readonly config: OhbabyBootstrapConfig;
  readonly fetch?: typeof fetch;
  readonly store: OhbabyWebStore;
}): BrowserDaemonClient {
  const http = createDaemonHttpClient(input.config, input.fetch);
  const events = new FetchDaemonEventStream({
    baseUrl: input.config.baseUrl,
    clientId: input.config.clientId,
    directory: input.config.directory,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    token: input.config.token,
  });
  return new BrowserDaemonClient({
    config: input.config,
    events,
    http,
    store: input.store,
  });
}
