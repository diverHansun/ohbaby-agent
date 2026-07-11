import type {
  CompactSessionRequest,
  CompactSessionResponse,
  CommandCatalogResponse,
  ContextWindowUsageResponse,
  CurrentModelResponse,
  ExecuteCommandRequest,
  ModelConnectRequest,
  ModelConnectResponse,
  ModelContextWindowProbeResponse,
  OhbabyBootstrapConfig,
  OkResponse,
  PermissionResponseRequest,
  PermissionStateResponse,
  PromptAcceptedResponse,
  RegisterClientResponse,
  SearchApiKeyRequest,
  SearchApiKeyResponse,
  SetPermissionRequest,
  SnapshotResponse,
  SubmitPromptRequest,
  WebStartupIntent,
  WorkspaceScopesResponse,
  WorkspaceOpenResponse,
  DirectoryPickerRootsResponse,
  DirectoryPickerListResponse,
} from "./wire.js";

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

  registerClient(input: {
    readonly startupIntent?: WebStartupIntent;
  }): Promise<RegisterClientResponse> {
    return this.request("/v1/clients", {
      body: {
        clientId: this.clientId,
        ...(input.startupIntent === undefined
          ? {}
          : { startupIntent: input.startupIntent }),
      },
      method: "POST",
    });
  }

  getSnapshot(): Promise<SnapshotResponse> {
    return this.request("/v1/snapshot");
  }

  listCommands(): Promise<CommandCatalogResponse> {
    return this.request("/v1/commands?surface=web");
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

  listDirectoryPickerRoots(): Promise<DirectoryPickerRootsResponse> {
    return this.request("/v1/directory-picker/roots", {
      includeDirectory: false,
    });
  }

  listDirectoryPickerEntries(
    directory: string,
  ): Promise<DirectoryPickerListResponse> {
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

  createSession(): Promise<OkResponse> {
    return this.request("/v1/sessions", {
      method: "POST",
    });
  }

  selectSession(sessionId: string): Promise<OkResponse> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/select`,
      {
        method: "PATCH",
      },
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

  submitPrompt(input: SubmitPromptRequest): Promise<PromptAcceptedResponse> {
    return this.request("/v1/prompts", {
      body: input,
      method: "POST",
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

  setPermission(input: SetPermissionRequest): Promise<PermissionStateResponse> {
    return this.request("/v1/permission", {
      body: input,
      method: "PATCH",
    });
  }

  getCurrentModel(): Promise<CurrentModelResponse> {
    return this.request("/v1/model");
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
    input: { readonly runId?: string } = {},
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
      readonly method?: "GET" | "PATCH" | "POST";
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
      ...(this.directory === undefined || options.includeDirectory === false
        ? {}
        : { "x-ohbaby-directory": this.directory }),
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
    });
    const value = (await response.json()) as unknown;
    if (!response.ok) {
      const message =
        isErrorBody(value) && typeof value.error?.message === "string"
          ? value.error.message
          : `Daemon request failed with HTTP ${String(response.status)}`;
      throw new Error(message);
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
