import type {
  OhbabyBootstrapConfig,
  OkResponse,
  PermissionResponseRequest,
  PermissionStateResponse,
  PromptAcceptedResponse,
  RegisterClientResponse,
  SetPermissionRequest,
  SnapshotResponse,
  SubmitPromptRequest,
  WebStartupIntent,
} from "./wire.js";

export interface DaemonHttpClientOptions {
  readonly baseUrl: string;
  readonly clientId: string;
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
  private readonly fetchImpl: typeof fetch;
  private readonly token: string;

  constructor(options: DaemonHttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.clientId = options.clientId;
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
      readonly method?: "GET" | "PATCH" | "POST";
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
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
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    token: config.token,
  });
}
