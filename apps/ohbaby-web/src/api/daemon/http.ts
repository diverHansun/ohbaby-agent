import type {
  UiSubagentQuery,
  UiSubagentExecutionList,
  UiSubagentExecutionView,
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
  ModelConnectRequest,
  ModelConnectResponse,
  ModelContextWindowProbeResponse,
  OhbabyBootstrapConfig,
  OkResponse,
  PermissionResponseRequest,
  PermissionStateResponse,
  PromptAcceptedResponse,
  PromptCompletionResponse,
  PromptLeaseResponse,
  PromptMutationResponse,
  RegisterClientResponse,
  SearchApiKeyRequest,
  SearchApiKeyResponse,
  SetPermissionRequest,
  SnapshotResponse,
  SubmitPromptRequest,
  WebStartupIntent,
  WorkspaceScopesResponse,
  WorkspaceOpenResponse,
} from "./wire.js";
import { workspaceDirectoryHeaders } from "ohbaby-sdk";
import type { UiInteractionResponse, UiSlashCommandSurface } from "ohbaby-sdk";

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
  };
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

  executeCommand(input: ExecuteCommandRequest): Promise<OkResponse> {
    return this.request("/v1/commands", {
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

  steerQueuedPrompt(
    promptId: string,
    expectedRunId: string,
    clientRequestId: string,
  ): Promise<{
    ok: true;
    receipt: import("ohbaby-sdk").UiSteerQueuedPromptReceipt;
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
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CurrentModelResponse> {
    return this.request("/v1/model", { signal: options.signal });
  }

  probeModelContextWindow(
    input: ModelConnectRequest,
  ): Promise<ModelContextWindowProbeResponse> {
    return this.request("/v1/model/context-window-probe", {
      body: input,
      method: "POST",
    });
  }

  connectModel(input: ModelConnectRequest): Promise<ModelConnectResponse> {
    return this.request("/v1/model", {
      body: input,
      method: "POST",
    });
  }

  setSearchApiKey(input: SearchApiKeyRequest): Promise<SearchApiKeyResponse> {
    return this.request("/v1/settings/search-api-key", {
      body: input,
      method: "POST",
    });
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
  ): Promise<CompactSessionResponse> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/compact`,
      {
        body: input,
        method: "POST",
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

  private async request<T>(
    path: string,
    options: {
      readonly body?: unknown;
      readonly includeDirectory?: boolean;
      readonly method?: "DELETE" | "GET" | "PATCH" | "POST";
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
      ...(this.directory === undefined || options.includeDirectory === false
        ? {}
        : workspaceDirectoryHeaders(this.directory)),
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
    const value = (await response.json()) as unknown;
    if (!response.ok) {
      const message =
        isErrorBody(value) && typeof value.error?.message === "string"
          ? value.error.message
          : `Daemon request failed with HTTP ${String(response.status)}`;
      throw Object.assign(new Error(message), {
        code: isErrorBody(value) ? value.error?.code : undefined,
        status: response.status,
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
