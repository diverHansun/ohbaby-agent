import type {
  UiSubagentQuery,
  UiSubagentExecutionList,
  UiSubagentExecutionView,
  UiSubagentConversationQuery,
  UiSubagentConversationView,
  UiSubagentConversationSelection,
  UiSubagentConversationUnwatchQuery,
  UiSubagentInstanceQuery,
  UiSubagentInstanceSnapshot,
  UiSubagentStopInput,
  UiSubagentStopResult,
} from "ohbaby-sdk";
import type {
  UiBackendClient,
  UiSessionScope,
  UiSessionView,
  UiSessionHistory,
  UiSessionControl,
  UiPromptReceiptQuery,
  UiPromptReceiptResult,
  UiPermissionSnapshotQuery,
  UiSessionCreationResult,
} from "ohbaby-sdk";
import type {
  BindingResponse,
  PermissionSnapshotResponse,
  SessionIndexResponse,
  CompactSessionRequest,
  CompactSessionResponse,
  CommandCatalogResponse,
  ContextWindowUsageResponse,
  CurrentModelResponse,
  DirectoryPickerListResponse,
  DirectoryPickerRootsResponse,
  ExecuteCommandRequest,
  OhbabyBootstrapConfig,
  OkResponse,
  PermissionResponseRequest,
  PermissionStateResponse,
  PromptAcceptedResponse,
  PromptCompletionResponse,
  PromptLeaseResponse,
  PromptMutationResponse,
  RegisterClientResponse,
  SetPermissionRequest,
  SnapshotResponse,
  SubmitPromptRequest,
  WebStartupIntent,
  WorkspaceScopesResponse,
  WorkspaceOpenResponse,
} from "./wire.js";
import { requestDirectoryHeaders } from "ohbaby-sdk";
import type {
  UiInteractionResponse,
  UiSettingsFieldError,
  UiSlashCommandSurface,
} from "ohbaby-sdk";

export interface DaemonHttpClientOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly directory?: string;
  readonly fetch?: typeof fetch;
  readonly token: string;
}

interface ErrorResponseBody {
  readonly error?: {
    readonly message?: string;
    readonly code?: string;
    readonly targetDirectory?: string;
    readonly fields?: unknown;
  };
}

/** Fields the transport keeps from a daemon error body. */
export interface DaemonRequestError extends Error {
  readonly code?: string;
  readonly status: number;
  /** Present on `SESSION_MOVED`: the directory the next request must use. */
  readonly targetDirectory?: string;
  /** Present on settings `VALIDATION_FAILED`: which request fields are invalid. */
  readonly fields?: readonly UiSettingsFieldError[];
}

export function isDaemonRequestError(
  error: unknown,
): error is DaemonRequestError {
  return (
    error instanceof Error &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  );
}

function requestUrl(baseUrl: string, path: string): string {
  if (baseUrl.length === 0) {
    return path;
  }
  return new URL(path, baseUrl).toString();
}

function isErrorBody(value: unknown): value is ErrorResponseBody {
  return typeof value === "object" && value !== null && "error" in value;
}

export class DaemonHttpClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly directory: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string;

  constructor(options: DaemonHttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.clientId = options.clientId;
    this.directory = options.directory;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.token = options.token;
  }

  registerClient(
    input: {
      readonly startupIntent?: WebStartupIntent;
    },
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<RegisterClientResponse> {
    return this.request("/v1/clients", {
      body: {
        clientId: this.clientId,
        ...(input.startupIntent === undefined
          ? {}
          : { startupIntent: input.startupIntent }),
      },
      method: "POST",
      signal: options.signal,
    });
  }

  getSessionIndex(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SessionIndexResponse> {
    return this.request("/v1/sessions/index", options);
  }

  getPermissionSnapshot(
    input: UiPermissionSnapshotQuery,
  ): Promise<PermissionSnapshotResponse> {
    const query = new URLSearchParams({
      rootSessionId: input.rootSessionId ?? "",
    });
    if (input.permissionEpoch !== undefined)
      query.set("permissionEpoch", input.permissionEpoch);
    if (input.bindingGeneration !== undefined)
      query.set("bindingGeneration", String(input.bindingGeneration));
    return this.request(`/v1/permissions?${query.toString()}`, {
      signal: input.signal,
    });
  }

  listSubagentExecutions(
    input: UiSubagentQuery,
  ): Promise<{ ok: true; result: UiSubagentExecutionList }> {
    return this.subagentRead(input);
  }
  getSubagentExecutionView(
    input: UiSubagentQuery & { executionId: string },
  ): Promise<{ ok: true; result: UiSubagentExecutionView }> {
    return this.subagentRead(input, input.executionId);
  }
  getSubagentConversationView(
    input: UiSubagentConversationQuery,
  ): Promise<{ ok: true; result: UiSubagentConversationView }> {
    const query = scopeQuery(input);
    if (input.before !== undefined) query.set("before", input.before);
    if (input.after !== undefined) query.set("after", input.after);
    if (input.anchorExecutionId !== undefined)
      query.set("anchorExecutionId", input.anchorExecutionId);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    return this.request(`${this.subagentConversationPath(input)}?${query}`, {
      signal: input.signal,
    });
  }
  watchSubagentConversation(
    input: UiSubagentConversationQuery,
  ): Promise<{ ok: true; result: UiSubagentConversationSelection }> {
    return this.request(`${this.subagentConversationPath(input)}/watch`, {
      body: {
        runtimeEpoch: input.runtimeEpoch,
        bindingGeneration: input.bindingGeneration,
        watchId: input.watchId,
        watchSequence: input.watchSequence,
      },
      method: "POST",
      signal: input.signal,
    });
  }
  unwatchSubagentConversation(
    input: UiSubagentConversationUnwatchQuery,
  ): Promise<{ ok: true }> {
    const query = scopeQuery(input);
    query.set("watchId", input.watchId);
    return this.request(
      `${this.subagentConversationPath(input)}/watch?${query}`,
      { method: "DELETE", signal: input.signal },
    );
  }
  listSubagentInstances(
    input: UiSubagentInstanceQuery,
  ): Promise<{ ok: true; result: UiSubagentInstanceSnapshot }> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(input.rootSessionId)}/subagent-instances?${scopeQuery(input)}`,
      { signal: input.signal },
    );
  }
  stopSubagent(
    input: UiSubagentStopInput,
  ): Promise<{ ok: true; result: UiSubagentStopResult }> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(input.rootSessionId)}/subagents/${encodeURIComponent(input.subagentId)}/stop`,
      {
        body: {
          runtimeEpoch: input.runtimeEpoch,
          bindingGeneration: input.bindingGeneration,
          expectedExecutionId: input.expectedExecutionId,
        },
        method: "POST",
        signal: input.signal,
      },
    );
  }
  private subagentConversationPath(input: UiSubagentConversationQuery): string {
    return `/v1/sessions/${encodeURIComponent(input.rootSessionId)}/subagents/${encodeURIComponent(input.subagentId)}/conversation`;
  }
  private subagentRead<T>(
    input: UiSubagentQuery,
    executionId?: string,
  ): Promise<T> {
    const query = scopeQuery(input);
    if (input.before !== undefined) query.set("before", input.before);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    return this.request(
      `/v1/sessions/${encodeURIComponent(input.rootSessionId)}/subagents${executionId ? `/${encodeURIComponent(executionId)}` : ""}?${query}`,
      { signal: input.signal },
    );
  }
  getSessionView(
    input: UiSessionScope,
  ): Promise<{ ok: true; view: UiSessionView }> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/view?${scopeQuery(input)}`,
      { signal: input.signal },
    );
  }
  getSessionHistory(
    input: UiSessionScope & {
      readonly before?: string;
      readonly limit?: number;
    },
  ): Promise<{ ok: true; history: UiSessionHistory }> {
    const query = scopeQuery(input);
    if (input.before !== undefined) query.set("before", input.before);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    return this.request(
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/history?${query}`,
      { signal: input.signal },
    );
  }
  getSessionControl(
    input: UiSessionScope,
  ): Promise<{ ok: true; control: UiSessionControl }> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/control?${scopeQuery(input)}`,
      { signal: input.signal },
    );
  }
  getPromptReceipt(
    input: UiPromptReceiptQuery,
  ): Promise<{ ok: true; result: UiPromptReceiptResult }> {
    const query = scopeQuery(input);
    query.set("clientRequestId", input.clientRequestId);
    if (input.sessionId !== undefined) query.set("sessionId", input.sessionId);
    return this.request(`/v1/prompts/receipt?${query}`, {
      signal: input.signal,
    });
  }

  getSnapshot(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SnapshotResponse> {
    return this.request("/v1/snapshot", { signal: options.signal });
  }

  listCommands(
    surface: UiSlashCommandSurface,
  ): Promise<CommandCatalogResponse> {
    return this.request(`/v1/commands?surface=${encodeURIComponent(surface)}`);
  }

  listWorkspaceScopes(): Promise<WorkspaceScopesResponse> {
    return this.request("/v1/scopes", { includeDirectory: false });
  }

  openWorkspace(directory: string): Promise<WorkspaceOpenResponse> {
    return this.request("/v1/scopes/open", {
      body: { directory },
      includeDirectory: false,
      method: "POST",
    });
  }

  hideWorkspace(directory: string): Promise<OkResponse> {
    return this.request("/v1/scopes/hide", {
      body: { directory },
      includeDirectory: false,
      method: "POST",
    });
  }

  getDirectoryPickerRoots(): Promise<DirectoryPickerRootsResponse> {
    return this.request("/v1/directory-picker/roots", {
      includeDirectory: false,
    });
  }

  listDirectoryPicker(directory: string): Promise<DirectoryPickerListResponse> {
    return this.request("/v1/directory-picker/list", {
      body: { directory },
      includeDirectory: false,
      method: "POST",
    });
  }

  executeCommand(
    input: ExecuteCommandRequest,
    signal?: AbortSignal,
  ): Promise<import("ohbaby-sdk").UiCommandCompletion & OkResponse> {
    return this.request("/v1/commands", {
      signal,
      body: input,
      method: "POST",
    });
  }

  createSession(
    options?: Parameters<UiBackendClient["createSession"]>[0],
  ): Promise<
    BindingResponse & {
      readonly session: UiSessionCreationResult;
      readonly created: boolean;
    }
  > {
    return this.request("/v1/sessions", {
      body: options === undefined ? { reuseEmpty: false } : { options },
      method: "POST",
    });
  }

  selectSession(sessionId: string): Promise<BindingResponse> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/select`,
      {
        method: "PATCH",
      },
    );
  }

  updateSessionModel(
    input: Parameters<UiBackendClient["updateSessionModel"]>[0],
  ): Promise<{
    ok: true;
    session: Awaited<ReturnType<UiBackendClient["updateSessionModel"]>>;
  }> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/model`,
      { method: "PATCH", body: { modelEntryId: input.modelEntryId } },
    );
  }

  updateSessionReasoning(
    input: Parameters<UiBackendClient["updateSessionReasoning"]>[0],
  ): Promise<{
    ok: true;
    session: Awaited<ReturnType<UiBackendClient["updateSessionReasoning"]>>;
  }> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/reasoning`,
      { method: "PATCH", body: { reasoning: input.reasoning } },
    );
  }

  exportSession(
    input: Parameters<UiBackendClient["exportSession"]>[0],
  ): Promise<{
    ok: true;
    export: Awaited<ReturnType<UiBackendClient["exportSession"]>>;
  }> {
    const query = new URLSearchParams({ format: input.format });
    return this.request(
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/export?${query}`,
    );
  }

  archiveSession(sessionId: string): Promise<OkResponse> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/archive`,
      {
        method: "PATCH",
      },
    );
  }

  submitPromptAccepted(
    input: SubmitPromptRequest,
  ): Promise<PromptAcceptedResponse> {
    return this.request("/v1/prompts", {
      body: input,
      method: "POST",
    });
  }

  waitForPrompt(
    promptId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PromptCompletionResponse> {
    return this.request(
      `/v1/prompts/${encodeURIComponent(promptId)}/completion`,
      { signal: options.signal },
    );
  }

  acquirePromptEditLease(promptId: string): Promise<PromptLeaseResponse> {
    return this.request(
      `/v1/prompts/${encodeURIComponent(promptId)}/edit-lease`,
      { method: "POST" },
    );
  }

  renewPromptEditLease(
    promptId: string,
    editLeaseId: string,
  ): Promise<PromptLeaseResponse> {
    return this.request(
      `/v1/prompts/${encodeURIComponent(promptId)}/edit-lease`,
      { body: { editLeaseId }, method: "PATCH" },
    );
  }

  releasePromptEditLease(
    promptId: string,
    editLeaseId: string,
  ): Promise<PromptMutationResponse> {
    return this.request(
      `/v1/prompts/${encodeURIComponent(promptId)}/edit-lease`,
      { body: { editLeaseId }, method: "DELETE" },
    );
  }

  editQueuedPrompt(
    promptId: string,
    editLeaseId: string,
    text: string,
  ): Promise<PromptMutationResponse> {
    return this.request(`/v1/prompts/${encodeURIComponent(promptId)}`, {
      body: { editLeaseId, text },
      method: "PATCH",
    });
  }

  resubmitRetainedPrompt(
    input: import("ohbaby-sdk").UiResubmitRetainedPromptInput,
  ): Promise<{
    ok: true;
    receipt: import("ohbaby-sdk").UiPromptResubmissionReceipt;
  }> {
    return this.request(
      `/v1/prompts/${encodeURIComponent(input.promptId)}/resubmit`,
      {
        body: {
          editLeaseId: input.editLeaseId,
          operationId: input.operationId,
          text: input.text,
        },
        method: "POST",
      },
    );
  }

  resendSteerInput(
    input: import("ohbaby-sdk").UiResendSteerInput,
  ): Promise<{ ok: true; receipt: import("ohbaby-sdk").UiPromptReceipt }> {
    return this.request(
      `/v1/steer-inputs/${encodeURIComponent(input.inputId)}/resend`,
      { body: { operationId: input.operationId }, method: "POST" },
    );
  }

  steerQueuedPrompt(
    promptId: string,
    expectedRunId: string,
    clientRequestId: string,
  ): Promise<{
    ok: true;
    result: import("ohbaby-sdk").UiSteerQueuedPromptResult;
  }> {
    return this.request(`/v1/prompts/${encodeURIComponent(promptId)}/steer`, {
      body: { expectedRunId, clientRequestId },
      method: "POST",
    });
  }

  cancelQueuedPrompt(
    promptId: string,
    editLeaseId?: string,
  ): Promise<PromptMutationResponse> {
    return this.request(`/v1/prompts/${encodeURIComponent(promptId)}`, {
      body: editLeaseId === undefined ? {} : { editLeaseId },
      method: "DELETE",
    });
  }

  respondPermission(
    requestId: string,
    response: PermissionResponseRequest,
  ): Promise<OkResponse> {
    return this.request(`/v1/permissions/${encodeURIComponent(requestId)}`, {
      body: response,
      method: "POST",
    });
  }

  respondInteraction(
    interactionId: string,
    response: UiInteractionResponse,
  ): Promise<OkResponse> {
    return this.request(
      `/v1/interactions/${encodeURIComponent(interactionId)}/respond`,
      { body: { response }, method: "POST" },
    );
  }

  setPermission(input: SetPermissionRequest): Promise<PermissionStateResponse> {
    return this.request("/v1/permission", {
      body: input,
      method: "PATCH",
    });
  }

  getCurrentModel(
    options: {
      readonly signal?: AbortSignal;
      readonly sessionId?: string;
    } = {},
  ): Promise<CurrentModelResponse> {
    const query =
      options.sessionId === undefined
        ? ""
        : `?${new URLSearchParams({ sessionId: options.sessionId })}`;
    return this.request(`/v1/model${query}`, { signal: options.signal });
  }

  getContextWindowUsage(
    sessionId: string,
  ): Promise<ContextWindowUsageResponse> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/context-window`,
    );
  }

  compactSession(
    sessionId: string,
    input: CompactSessionRequest = {},
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CompactSessionResponse> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/compact`,
      {
        body: input,
        method: "POST",
        signal: options.signal,
      },
    );
  }

  abortSession(
    sessionId: string,
    input: {
      readonly runId?: string;
      readonly runtimeEpoch?: string;
      readonly bindingGeneration?: number;
    } = {},
  ): Promise<OkResponse> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/abort`, {
      body: input,
      method: "POST",
    });
  }

  /** Shared transport: auth, JSON, cancellation and error parsing. */
  async request<T>(
    path: string,
    options: {
      readonly body?: unknown;
      readonly includeDirectory?: boolean;
      readonly method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
      ...(this.directory === undefined || options.includeDirectory === false
        ? {}
        : requestDirectoryHeaders(this.directory)),
      "x-ohbaby-client-id": this.clientId,
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const response = await this.fetchImpl(requestUrl(this.baseUrl, path), {
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      method: options.method ?? "GET",
      signal: options.signal,
    });
    let value: unknown;
    try {
      value = (await response.json()) as unknown;
    } catch (error) {
      if (response.ok) throw error;
      value = undefined;
    }
    if (!response.ok) {
      const message =
        isErrorBody(value) && typeof value.error?.message === "string"
          ? value.error.message
          : `Daemon request failed with HTTP ${String(response.status)}`;
      const body = isErrorBody(value) ? value.error : undefined;
      const fields = fieldErrors(body?.fields);
      throw Object.assign(new Error(message), {
        code: body?.code,
        status: response.status,
        ...(typeof body?.targetDirectory === "string"
          ? { targetDirectory: body.targetDirectory }
          : {}),
        ...(fields === undefined ? {} : { fields }),
      });
    }
    return value as T;
  }
}

export function createDaemonHttpClient(
  config: OhbabyBootstrapConfig,
  fetchImpl?: typeof fetch,
): DaemonHttpClient {
  return new DaemonHttpClient({
    baseUrl: config.baseUrl,
    clientId: config.clientId,
    directory: config.directory,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    token: config.token,
  });
}

/** Keeps only well-formed `{ path, message }` entries of an error body. */
function fieldErrors(value: unknown): UiSettingsFieldError[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry: unknown): UiSettingsFieldError[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { path, message } = entry as { path?: unknown; message?: unknown };
    if (!Array.isArray(path) || typeof message !== "string") return [];
    return [
      {
        path: path.filter(
          (part): part is string | number =>
            typeof part === "string" || typeof part === "number",
        ),
        message,
      },
    ];
  });
}

function scopeQuery(input: {
  readonly runtimeEpoch?: string;
  readonly bindingGeneration?: number;
}): URLSearchParams {
  const query = new URLSearchParams();
  if (input.runtimeEpoch !== undefined)
    query.set("runtimeEpoch", input.runtimeEpoch);
  if (input.bindingGeneration !== undefined)
    query.set("bindingGeneration", String(input.bindingGeneration));
  return query;
}
