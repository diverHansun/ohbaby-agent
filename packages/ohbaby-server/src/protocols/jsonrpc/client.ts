import type { UiSubagentReadClient } from "ohbaby-sdk";
import { randomUUID } from "node:crypto";
import type { CoreApiHost } from "ohbaby-agent";
import {
  submitPromptAndWait as composeSubmitPromptAndWait,
  workspaceDirectoryHeaders,
} from "ohbaby-sdk";
import type {
  SDKAPI,
  UiBackendClient,
  UiEvent,
  UiEventHandler,
  UiSessionRecoveryClient,
  UiSessionScope,
  UiPromptReceiptQuery,
  UiPermissionBinding,
  UiPermissionEvent,
} from "ohbaby-sdk";
import { daemonAuthHeader } from "../../auth/token.js";
import {
  createDaemonRpcRequest,
  parseDaemonSseEvent,
  type DaemonRpcMethod,
  type DaemonRpcResponse,
  type DaemonStartupIntent,
} from "./protocol.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_STARTUP_INTENT: DaemonStartupIntent = {
  startupSessionMode: { type: "fresh" },
};
const SSE_RECONNECT_DELAY_MS = 50;

export interface RemoteDaemonClientOptions {
  readonly authToken?: string;
  readonly host?: string;
  readonly port: number;
  readonly fetch?: typeof fetch;
  readonly clientId?: string;
  readonly directory?: string;
  readonly startupIntent?: DaemonStartupIntent;
}

type RemoteUiBackendClient = UiBackendClient &
  UiSessionRecoveryClient & {
    dispose(): Promise<void>;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRpcResponse(value: unknown): DaemonRpcResponse {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new TypeError("Daemon rpc response must include an id");
  }
  if (value.ok === true) {
    return {
      id: value.id,
      ok: true,
      result: value.result,
    };
  }
  if (value.ok === false) {
    const error = value.error;
    if (!isRecord(error) || typeof error.message !== "string") {
      throw new TypeError("Daemon rpc failure must include an error message");
    }
    return {
      error: {
        message: error.message,
        ...(typeof error.name === "string" ? { name: error.name } : {}),
        ...(typeof error.code === "string" ? { code: error.code } : {}),
        ...(error.source === "provider" ||
        error.source === "runtime" ||
        error.source === "scheduler" ||
        error.source === "validation"
          ? { source: error.source }
          : {}),
        ...(typeof error.retryable === "boolean"
          ? { retryable: error.retryable }
          : {}),
        ...(typeof error.providerId === "string"
          ? { providerId: error.providerId }
          : {}),
        ...(typeof error.statusCode === "number"
          ? { statusCode: error.statusCode }
          : {}),
        ...(typeof error.attempts === "number"
          ? { attempts: error.attempts }
          : {}),
        ...(typeof error.limit === "number" ? { limit: error.limit } : {}),
        ...(typeof error.terminalReason === "string"
          ? { terminalReason: error.terminalReason }
          : {}),
      },
      id: value.id,
      ok: false,
    };
  }
  throw new TypeError("Daemon rpc response ok flag is required");
}

function isAbortError(error: unknown): boolean {
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.code === DOMException.ABORT_ERR)
  ) {
    return true;
  }
  if (
    isRecord(error) &&
    (error.name === "AbortError" || error.code === "ABORT_ERR")
  ) {
    return true;
  }
  return false;
}

function ignoreAbort(error: unknown): void {
  if (isAbortError(error)) {
    return;
  }
  throw error;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function daemonConnectionError(method: DaemonRpcMethod, error: unknown): Error {
  return new Error(
    `Daemon connection failed while running ${method}: ${errorMessage(error)}`,
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timeout = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

class RemoteDaemonClient implements RemoteUiBackendClient {
  private readonly baseUrl: string;
  private readonly authToken: string | undefined;
  private readonly clientId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly directory: string | undefined;
  private readonly startupIntent: DaemonStartupIntent | undefined;
  private readonly handlers = new Set<UiEventHandler>();
  private readonly permissionHandlers = new Map<
    (event: UiPermissionEvent) => void,
    ((error: unknown) => void) | undefined
  >();
  private permissionBinding: UiPermissionBinding | undefined;
  private connectionGeneration = 0;
  private sessionRecoveryVersion = 0;
  private permissionConnectionLive = false;
  private abortController: AbortController | undefined;
  private initializePromise: Promise<void> | undefined;
  private lastEventId: string | undefined;
  private sseLoop: Promise<void> | undefined;

  constructor(options: RemoteDaemonClientOptions) {
    this.authToken = options.authToken;
    this.clientId = options.clientId ?? randomUUID();
    this.directory = options.directory;
    this.startupIntent = options.startupIntent ?? DEFAULT_STARTUP_INTENT;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("fetch is required to create a remote daemon client");
    }
    const host = options.host ?? DEFAULT_HOST;
    this.baseUrl = `http://${host}:${String(options.port)}`;
  }

  private adoptPermissionBinding(
    binding: UiPermissionBinding,
    expectedEpoch?: string,
  ): void {
    const current = this.permissionBinding;
    if (
      current &&
      (current.permissionEpoch !== expectedEpoch ||
        binding.permissionEpoch !== current.permissionEpoch ||
        binding.bindingGeneration < current.bindingGeneration)
    )
      return;
    this.permissionBinding = {
      permissionEpoch: binding.permissionEpoch,
      rootSessionId: binding.rootSessionId,
      bindingGeneration: binding.bindingGeneration,
    };
  }

  getSessionIndex(): ReturnType<UiBackendClient["getSessionIndex"]> {
    return this.rpc("getSessionIndex", []);
  }
  async getSelectedSessionId(): Promise<string | null> {
    await this.ensureInitialized();
    return this.permissionBinding?.rootSessionId ?? null;
  }
  async createSession(
    input?: Parameters<UiBackendClient["createSession"]>[0],
  ): ReturnType<UiBackendClient["createSession"]> {
    await this.ensureInitialized();
    const epoch = this.permissionBinding?.permissionEpoch;
    const result = await this.rpc<
      UiPermissionBinding & {
        session: Awaited<ReturnType<UiBackendClient["createSession"]>>;
      }
    >("createSession", input === undefined ? [] : [input]);
    this.adoptPermissionBinding(result, epoch);
    return result.session;
  }
  async selectSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    const epoch = this.permissionBinding?.permissionEpoch;
    const binding = await this.rpc<UiPermissionBinding>("selectSession", [
      sessionId,
      this.permissionBinding?.bindingGeneration,
    ]);
    this.adoptPermissionBinding(binding, epoch);
  }
  async getPermissionSnapshot(
    input: Parameters<UiBackendClient["getPermissionSnapshot"]>[0],
  ): ReturnType<UiBackendClient["getPermissionSnapshot"]> {
    await this.ensureInitialized();
    if (this.permissionHandlers.size > 0 && !this.permissionConnectionLive)
      throw new Error("Permission event connection is not ready");
    return this.rpc(
      "getPermissionSnapshot",
      [{ ...this.permissionBinding, ...input, signal: undefined }],
      { signal: input.signal },
    );
  }
  subscribePermissionEvents(
    handler: (event: UiPermissionEvent) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    this.permissionHandlers.set(handler, onError);
    this.ensureSseLoop();
    return () => {
      this.permissionHandlers.delete(handler);
      if (this.handlers.size === 0 && this.permissionHandlers.size === 0)
        this.abortSseLoop();
    };
  }

  private async sessionQuery<K extends keyof UiSessionRecoveryClient>(
    method: K,
    input: Parameters<UiSessionRecoveryClient[K]>[0],
  ): Promise<Awaited<ReturnType<UiSessionRecoveryClient[K]>>> {
    await this.ensureInitialized();
    if (this.sessionRecoveryVersion !== 1)
      throw Object.assign(
        new Error("Daemon does not support session recovery"),
        { code: "SESSION_RECOVERY_UNSUPPORTED" },
      );
    const binding = this.permissionBinding;
    const result = await this.rpc<
      Awaited<ReturnType<UiSessionRecoveryClient[K]>>
    >(
      method,
      [
        {
          ...input,
          runtimeEpoch: input.runtimeEpoch ?? binding?.permissionEpoch,
          bindingGeneration:
            input.bindingGeneration ?? binding?.bindingGeneration,
          signal: undefined,
        },
      ],
      { signal: input.signal },
    );
    if (
      binding !== this.permissionBinding &&
      (binding?.permissionEpoch !== this.permissionBinding?.permissionEpoch ||
        binding?.bindingGeneration !==
          this.permissionBinding?.bindingGeneration)
    )
      throw Object.assign(new Error("Session binding changed during query"), {
        code: "SESSION_SCOPE_CHANGED",
      });
    return result;
  }
  private async subagentQuery<K extends keyof UiSubagentReadClient>(
    method: K,
    input: Parameters<UiSubagentReadClient[K]>[0],
  ): Promise<Awaited<ReturnType<UiSubagentReadClient[K]>>> {
    await this.ensureInitialized();
    const binding = this.permissionBinding;
    const result = await this.rpc<Awaited<ReturnType<UiSubagentReadClient[K]>>>(
      method,
      [
        {
          ...input,
          signal: undefined,
          runtimeEpoch: binding?.permissionEpoch,
          bindingGeneration: binding?.bindingGeneration,
        },
      ],
      { signal: input.signal },
    );
    if (
      binding?.permissionEpoch !== this.permissionBinding?.permissionEpoch ||
      binding?.bindingGeneration !== this.permissionBinding?.bindingGeneration
    )
      throw new Error("Session binding changed during execution query");
    return result;
  }
  listSubagentExecutions(
    input: Parameters<UiSubagentReadClient["listSubagentExecutions"]>[0],
  ): ReturnType<UiSubagentReadClient["listSubagentExecutions"]> {
    return this.subagentQuery("listSubagentExecutions", input);
  }
  getSubagentExecutionView(
    input: Parameters<UiSubagentReadClient["getSubagentExecutionView"]>[0],
  ): ReturnType<UiSubagentReadClient["getSubagentExecutionView"]> {
    return this.subagentQuery("getSubagentExecutionView", input);
  }
  getSubagentConversationView(
    input: Parameters<UiSubagentReadClient["getSubagentConversationView"]>[0],
  ): ReturnType<UiSubagentReadClient["getSubagentConversationView"]> {
    return this.subagentQuery("getSubagentConversationView", input);
  }
  watchSubagentConversation(
    input: Parameters<UiSubagentReadClient["watchSubagentConversation"]>[0],
  ): ReturnType<UiSubagentReadClient["watchSubagentConversation"]> {
    return this.subagentQuery("watchSubagentConversation", input);
  }
  unwatchSubagentConversation(
    input: Parameters<UiSubagentReadClient["unwatchSubagentConversation"]>[0],
  ): ReturnType<UiSubagentReadClient["unwatchSubagentConversation"]> {
    return this.subagentQuery("unwatchSubagentConversation", input);
  }
  getSessionView(
    input: UiSessionScope,
  ): ReturnType<UiSessionRecoveryClient["getSessionView"]> {
    return this.sessionQuery("getSessionView", input);
  }
  getSessionHistory(
    input: Parameters<UiSessionRecoveryClient["getSessionHistory"]>[0],
  ): ReturnType<UiSessionRecoveryClient["getSessionHistory"]> {
    return this.sessionQuery("getSessionHistory", input);
  }
  getSessionControl(
    input: UiSessionScope,
  ): ReturnType<UiSessionRecoveryClient["getSessionControl"]> {
    return this.sessionQuery("getSessionControl", input);
  }
  getPromptReceipt(
    input: UiPromptReceiptQuery,
  ): ReturnType<UiSessionRecoveryClient["getPromptReceipt"]> {
    return this.sessionQuery("getPromptReceipt", input);
  }

  getSnapshot(): ReturnType<UiBackendClient["getSnapshot"]> {
    return this.rpc("getSnapshot", []);
  }

  getContextWindowUsage(
    input: Parameters<UiBackendClient["getContextWindowUsage"]>[0],
  ): ReturnType<UiBackendClient["getContextWindowUsage"]> {
    return this.rpc("getContextWindowUsage", [input]);
  }

  subscribeEvents(
    handler: UiEventHandler,
  ): ReturnType<UiBackendClient["subscribeEvents"]> {
    this.handlers.add(handler);
    this.ensureSseLoop();
    return () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0 && this.permissionHandlers.size === 0) {
        this.abortSseLoop();
      }
    };
  }

  listCommands(
    query: Parameters<UiBackendClient["listCommands"]>[0],
  ): ReturnType<UiBackendClient["listCommands"]> {
    return this.rpc("listCommands", [query]);
  }

  async submitPromptAccepted(
    text: string,
    options?: Parameters<UiBackendClient["submitPromptAccepted"]>[1],
  ): ReturnType<UiBackendClient["submitPromptAccepted"]> {
    await this.ensureInitialized();
    const epoch = this.permissionBinding?.permissionEpoch;
    const result = await this.rpc<
      Awaited<ReturnType<UiBackendClient["submitPromptAccepted"]>> &
        UiPermissionBinding
    >("submitPromptAccepted", [text, options]);
    this.adoptPermissionBinding(result, epoch);
    return result;
  }

  submitPromptAndWait(
    text: string,
    options?: Parameters<UiBackendClient["submitPromptAndWait"]>[1],
  ): ReturnType<UiBackendClient["submitPromptAndWait"]> {
    return composeSubmitPromptAndWait(this, text, options);
  }

  editQueuedPrompt(
    input: Parameters<UiBackendClient["editQueuedPrompt"]>[0],
  ): ReturnType<UiBackendClient["editQueuedPrompt"]> {
    return this.rpc("editQueuedPrompt", [input]);
  }

  steerQueuedPrompt(
    input: Parameters<UiBackendClient["steerQueuedPrompt"]>[0],
  ): ReturnType<UiBackendClient["steerQueuedPrompt"]> {
    return this.rpc("steerQueuedPrompt", [input]);
  }

  cancelQueuedPrompt(
    input: Parameters<UiBackendClient["cancelQueuedPrompt"]>[0],
  ): ReturnType<UiBackendClient["cancelQueuedPrompt"]> {
    return this.rpc("cancelQueuedPrompt", [input]);
  }

  acquirePromptEditLease(
    input: Parameters<UiBackendClient["acquirePromptEditLease"]>[0],
  ): ReturnType<UiBackendClient["acquirePromptEditLease"]> {
    return this.rpc("acquirePromptEditLease", [input]);
  }

  renewPromptEditLease(
    input: Parameters<UiBackendClient["renewPromptEditLease"]>[0],
  ): ReturnType<UiBackendClient["renewPromptEditLease"]> {
    return this.rpc("renewPromptEditLease", [input]);
  }

  releasePromptEditLease(
    input: Parameters<UiBackendClient["releasePromptEditLease"]>[0],
  ): ReturnType<UiBackendClient["releasePromptEditLease"]> {
    return this.rpc("releasePromptEditLease", [input]);
  }

  waitForPrompt(
    promptId: string,
    options?: Parameters<UiBackendClient["waitForPrompt"]>[1],
  ): ReturnType<UiBackendClient["waitForPrompt"]> {
    return this.rpc("waitForPrompt", [promptId], { signal: options?.signal });
  }

  compactSession(
    options?: Parameters<UiBackendClient["compactSession"]>[0],
  ): ReturnType<UiBackendClient["compactSession"]> {
    return this.rpc("compactSession", [options]);
  }

  updateSessionReasoning(
    input: Parameters<UiBackendClient["updateSessionReasoning"]>[0],
  ): ReturnType<UiBackendClient["updateSessionReasoning"]> {
    return this.rpc("updateSessionReasoning", [input]);
  }

  archiveSession(
    input: Parameters<UiBackendClient["archiveSession"]>[0],
  ): ReturnType<UiBackendClient["archiveSession"]> {
    return this.rpc("archiveSession", [input]);
  }

  getCurrentModel(): ReturnType<UiBackendClient["getCurrentModel"]> {
    return this.rpc("getCurrentModel", []);
  }

  probeModelContextWindow(
    input: Parameters<UiBackendClient["probeModelContextWindow"]>[0],
  ): ReturnType<UiBackendClient["probeModelContextWindow"]> {
    return this.rpc("probeModelContextWindow", [input]);
  }

  connectModel(
    input: Parameters<UiBackendClient["connectModel"]>[0],
  ): ReturnType<UiBackendClient["connectModel"]> {
    return this.rpc("connectModel", [input]);
  }

  setSearchApiKey(
    input: Parameters<UiBackendClient["setSearchApiKey"]>[0],
  ): ReturnType<UiBackendClient["setSearchApiKey"]> {
    return this.rpc("setSearchApiKey", [input]);
  }

  setPermission(
    input: Parameters<UiBackendClient["setPermission"]>[0],
  ): ReturnType<UiBackendClient["setPermission"]> {
    return this.rpc("setPermission", [input]);
  }

  executeCommand(
    invocation: Parameters<UiBackendClient["executeCommand"]>[0],
  ): ReturnType<UiBackendClient["executeCommand"]> {
    return this.rpc("executeCommand", [invocation]);
  }

  respondPermission(
    requestId: string,
    response: Parameters<UiBackendClient["respondPermission"]>[1],
    context?: Parameters<UiBackendClient["respondPermission"]>[2],
  ): ReturnType<UiBackendClient["respondPermission"]> {
    return this.ensureInitialized().then(() =>
      this.rpc("respondPermission", [
        requestId,
        response,
        context ?? this.permissionBinding,
      ]),
    );
  }

  respondInteraction(
    interactionId: string,
    response: Parameters<UiBackendClient["respondInteraction"]>[1],
  ): ReturnType<UiBackendClient["respondInteraction"]> {
    return this.rpc("respondInteraction", [interactionId, response]);
  }

  async abortRun(runId: string): ReturnType<UiBackendClient["abortRun"]> {
    await this.ensureInitialized();
    const binding = this.permissionBinding;
    await this.rpc("abortRun", [
      runId,
      {
        sessionId: binding?.rootSessionId,
        runtimeEpoch: binding?.permissionEpoch,
        bindingGeneration: binding?.bindingGeneration,
      },
    ]);
  }

  async dispose(): Promise<void> {
    this.handlers.clear();
    this.permissionHandlers.clear();
    const pendingLoop = this.sseLoop;
    this.abortSseLoop();
    await pendingLoop?.catch((error: unknown) => {
      ignoreAbort(error);
    });
  }

  private async rpc<T>(
    method: DaemonRpcMethod,
    params: readonly unknown[],
    options: {
      readonly signal?: AbortSignal;
      readonly skipInitialize?: boolean;
    } = {},
  ): Promise<T> {
    if (options.skipInitialize !== true) {
      await this.ensureInitialized();
    }
    const request = createDaemonRpcRequest({
      clientId: this.clientId,
      id: randomUUID(),
      method,
      params,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/rpc`, {
        body: JSON.stringify(request),
        headers: this.requestHeaders({ "content-type": "application/json" }),
        method: "POST",
        signal: options.signal,
      });
    } catch (error) {
      throw daemonConnectionError(method, error);
    }
    let responseJson: unknown;
    try {
      responseJson = await response.json();
    } catch (error) {
      if (!response.ok) {
        throw new Error(
          `Daemon request ${method} failed with HTTP ${String(response.status)}`,
        );
      }
      throw new Error(
        `Daemon request ${method} returned invalid JSON: ${errorMessage(error)}`,
      );
    }
    const body = parseRpcResponse(responseJson);
    if (!body.ok) {
      throw Object.assign(new Error(body.error.message), body.error);
    }
    if (!response.ok) {
      throw new Error(
        `Daemon request ${method} failed with HTTP ${String(response.status)}`,
      );
    }
    return body.result as T;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.startupIntent === undefined) {
      return;
    }
    this.initializePromise ??= this.rpc<
      | (UiPermissionBinding & {
          runtimeEpoch?: string;
          sessionRecoveryVersion?: number;
        })
      | undefined
    >("initializeClient", [this.startupIntent], {
      skipInitialize: true,
    }).then((binding) => {
      this.permissionBinding = binding;
      this.sessionRecoveryVersion =
        binding?.runtimeEpoch === binding?.permissionEpoch
          ? (binding?.sessionRecoveryVersion ?? 0)
          : 0;
    });
    await this.initializePromise;
  }

  private ensureSseLoop(): void {
    if (this.sseLoop) {
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    this.sseLoop = this.runSseReconnectLoop(controller.signal)
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }
      })
      .finally(() => {
        if (this.abortController === controller) {
          this.abortController = undefined;
          this.sseLoop = undefined;
        }
      });
  }

  private abortSseLoop(): void {
    this.permissionConnectionLive = false;
    this.abortController?.abort();
    this.abortController = undefined;
    this.sseLoop = undefined;
  }

  private async runSseReconnectLoop(signal: AbortSignal): Promise<void> {
    await this.ensureInitialized();
    while (
      !signal.aborted &&
      (this.handlers.size > 0 || this.permissionHandlers.size > 0)
    ) {
      try {
        await this.openSseConnection(signal);
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
      }
      this.permissionConnectionLive = false;
      this.emitSessionResync(true);
      this.permissionFailure(
        new Error("Permission event connection interrupted"),
      );
      if (this.handlers.size > 0 || this.permissionHandlers.size > 0) {
        await delay(SSE_RECONNECT_DELAY_MS, signal);
      }
    }
  }

  private async openSseConnection(signal: AbortSignal): Promise<void> {
    const url = new URL(`${this.baseUrl}/api/events`);
    url.searchParams.set("clientId", this.clientId);
    const headers = this.requestHeaders({ accept: "text/event-stream" });
    if (this.lastEventId !== undefined) {
      headers["last-event-id"] = this.lastEventId;
    }
    const response = await this.fetchImpl(url, {
      headers,
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Daemon SSE connection failed: ${String(response.status)}`,
      );
    }
    const reader = response.body?.getReader() as
      | ReadableStreamDefaultReader<Uint8Array>
      | undefined;
    if (!reader) {
      throw new Error("Daemon SSE response body is missing");
    }

    this.connectionGeneration += 1;
    const abortReader = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", abortReader, { once: true });
    try {
      await this.readSseFrames(reader, signal);
    } finally {
      signal.removeEventListener("abort", abortReader);
      reader.releaseLock();
    }
  }

  private async readSseFrames(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      if (signal.aborted) {
        return;
      }
      const readResult = await reader.read();
      if (readResult.done) {
        return;
      }
      buffer += decoder.decode(readResult.value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) {
          break;
        }
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        this.handleSseFrame(frame);
      }
    }
  }

  private handleSseFrame(frame: string): void {
    const lines = frame.split("\n");
    const id = lines
      .find((line) => line.startsWith("id: "))
      ?.slice("id: ".length);
    const data = lines
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    if (!data) {
      return;
    }

    const event = parseDaemonSseEvent(JSON.parse(data) as unknown);
    if (event.type === "hello") {
      this.permissionConnectionLive = true;
      if (
        this.permissionBinding?.permissionEpoch === event.permissionEpoch &&
        event.bindingGeneration < this.permissionBinding.bindingGeneration
      )
        return;
      this.permissionBinding = {
        permissionEpoch: event.permissionEpoch,
        rootSessionId: event.rootSessionId,
        bindingGeneration: event.bindingGeneration,
      };
      this.sessionRecoveryVersion =
        event.runtimeEpoch === event.permissionEpoch
          ? (event.sessionRecoveryVersion ?? 0)
          : 0;
      this.emitSessionResync();
      this.emitPermissionEvent({
        type: "permission.resync-required",
        ...this.permissionBinding,
        connectionGeneration: this.connectionGeneration,
      });
      return;
    }
    if (event.type === "resync-required") {
      this.lastEventId = String(event.maxSeqNum);
      if (this.permissionBinding)
        this.emitPermissionEvent({
          type: "permission.resync-required",
          ...this.permissionBinding,
        });
      this.emitSessionResync();
      return;
    }
    if (event.type !== "ui.event") {
      return;
    }
    if (
      event.event.type === "permission.requested" ||
      event.event.type === "permission.resolved" ||
      event.event.type === "permission.unavailable"
    ) {
      this.emitPermissionEvent(event.event);
      return;
    }
    if (id !== undefined) this.lastEventId = id;
    if (event.event.type !== "snapshot.replaced") this.emitEvent(event.event);
  }

  private emitSessionResync(disconnected = false): void {
    const binding = this.permissionBinding;
    if (!binding) return;
    this.emitEvent({
      type: "session.resync-required",
      runtimeEpoch: binding.permissionEpoch,
      sessionId: binding.rootSessionId,
      bindingGeneration: binding.bindingGeneration,
      connectionGeneration: this.connectionGeneration,
      disconnected,
      unsupported: this.sessionRecoveryVersion !== 1,
    });
  }

  private permissionFailure(error: unknown): void {
    for (const onError of this.permissionHandlers.values()) {
      try {
        onError?.(error);
      } catch {
        /* Observer owns its failure. */
      }
    }
  }
  private emitPermissionEvent(event: UiPermissionEvent): void {
    for (const [handler, onError] of [...this.permissionHandlers]) {
      try {
        handler(event);
      } catch (error) {
        try {
          onError?.(error);
        } catch {
          /* Observer owns its failure. */
        }
      }
    }
  }

  private emitEvent(event: UiEvent): void {
    for (const handler of Array.from(this.handlers)) {
      try {
        handler(event);
      } catch {
        /* Observer owns its failure. */
      }
    }
  }

  private requestHeaders(
    headers: Record<string, string>,
  ): Record<string, string> {
    return {
      ...headers,
      ...(this.authToken === undefined
        ? {}
        : { authorization: daemonAuthHeader(this.authToken) }),
      ...workspaceDirectoryHeaders(this.directory),
    };
  }
}

export function createRemoteUiBackendClient(
  options: RemoteDaemonClientOptions,
): RemoteUiBackendClient {
  return new RemoteDaemonClient(options);
}

export function createRemoteCoreApiHost(
  options: RemoteDaemonClientOptions,
): CoreApiHost {
  const client = createRemoteUiBackendClient(options);
  return {
    callbacks: {
      subscribeEvents(handler): ReturnType<SDKAPI["subscribeEvents"]> {
        return client.subscribeEvents(handler);
      },
    },
    core: client,
    dispose(): Promise<void> {
      return client.dispose();
    },
  };
}
