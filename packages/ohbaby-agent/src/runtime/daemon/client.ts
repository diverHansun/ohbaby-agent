import { randomUUID } from "node:crypto";
import type { CoreAPI, SDKAPI, UiBackendClient, UiEventHandler } from "ohbaby-sdk";
import type { CoreApiHost } from "../../host/core-api-factory.js";
import {
  createDaemonRpcRequest,
  parseDaemonSseEvent,
  type DaemonRpcMethod,
  type DaemonRpcResponse,
} from "./protocol.js";

const DEFAULT_HOST = "127.0.0.1";

export interface RemoteDaemonClientOptions {
  readonly host?: string;
  readonly port: number;
  readonly fetch?: typeof fetch;
  readonly clientId?: string;
}

type RemoteUiBackendClient = UiBackendClient & {
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

class RemoteDaemonClient implements RemoteUiBackendClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly handlers = new Set<UiEventHandler>();
  private abortController: AbortController | undefined;
  private sseLoop: Promise<void> | undefined;

  constructor(options: RemoteDaemonClientOptions) {
    this.clientId = options.clientId ?? randomUUID();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("fetch is required to create a remote daemon client");
    }
    const host = options.host ?? DEFAULT_HOST;
    this.baseUrl = `http://${host}:${String(options.port)}`;
  }

  getSnapshot(): ReturnType<UiBackendClient["getSnapshot"]> {
    return this.rpc("getSnapshot", []);
  }

  getContextWindowUsage(
    input: Parameters<UiBackendClient["getContextWindowUsage"]>[0],
  ): ReturnType<UiBackendClient["getContextWindowUsage"]> {
    return this.rpc("getContextWindowUsage", [input]);
  }

  subscribeEvents(handler: UiEventHandler): ReturnType<
    UiBackendClient["subscribeEvents"]
  > {
    this.handlers.add(handler);
    this.ensureSseLoop();
    return () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0) {
        this.abortSseLoop();
      }
    };
  }

  listCommands(
    query: Parameters<UiBackendClient["listCommands"]>[0],
  ): ReturnType<UiBackendClient["listCommands"]> {
    return this.rpc("listCommands", [query]);
  }

  submitPrompt(
    text: string,
    options?: Parameters<UiBackendClient["submitPrompt"]>[1],
  ): ReturnType<UiBackendClient["submitPrompt"]> {
    return this.rpc("submitPrompt", [text, options]);
  }

  compactSession(
    options?: Parameters<UiBackendClient["compactSession"]>[0],
  ): ReturnType<UiBackendClient["compactSession"]> {
    return this.rpc("compactSession", [options]);
  }

  getCurrentModel(): ReturnType<UiBackendClient["getCurrentModel"]> {
    return this.rpc("getCurrentModel", []);
  }

  connectModel(
    input: Parameters<UiBackendClient["connectModel"]>[0],
  ): ReturnType<UiBackendClient["connectModel"]> {
    return this.rpc("connectModel", [input]);
  }

  executeCommand(
    invocation: Parameters<UiBackendClient["executeCommand"]>[0],
  ): ReturnType<UiBackendClient["executeCommand"]> {
    return this.rpc("executeCommand", [invocation]);
  }

  respondPermission(
    requestId: string,
    response: Parameters<UiBackendClient["respondPermission"]>[1],
  ): ReturnType<UiBackendClient["respondPermission"]> {
    return this.rpc("respondPermission", [requestId, response]);
  }

  respondInteraction(
    interactionId: string,
    response: Parameters<UiBackendClient["respondInteraction"]>[1],
  ): ReturnType<UiBackendClient["respondInteraction"]> {
    return this.rpc("respondInteraction", [interactionId, response]);
  }

  abortRun(runId?: string): ReturnType<UiBackendClient["abortRun"]> {
    return this.rpc("abortRun", [runId]);
  }

  async dispose(): Promise<void> {
    this.handlers.clear();
    const pendingLoop = this.sseLoop;
    this.abortSseLoop();
    await pendingLoop?.catch((error: unknown) => {
      ignoreAbort(error);
    });
  }

  private async rpc<T>(
    method: DaemonRpcMethod,
    params: readonly unknown[],
  ): Promise<T> {
    const request = createDaemonRpcRequest({
      clientId: this.clientId,
      id: randomUUID(),
      method,
      params,
    });
    const response = await this.fetchImpl(`${this.baseUrl}/api/rpc`, {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = parseRpcResponse(await response.json());
    if (!body.ok) {
      throw new Error(body.error.message);
    }
    return body.result as T;
  }

  private ensureSseLoop(): void {
    if (this.sseLoop) {
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    this.sseLoop = this.runSseLoop(controller.signal)
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
    this.abortController?.abort();
    this.abortController = undefined;
    this.sseLoop = undefined;
  }

  private async runSseLoop(signal: AbortSignal): Promise<void> {
    const url = new URL(`${this.baseUrl}/api/events`);
    url.searchParams.set("clientId", this.clientId);
    const response = await this.fetchImpl(url, {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!response.ok) {
      throw new Error(`Daemon SSE connection failed: ${String(response.status)}`);
    }
    const reader = response.body?.getReader() as
      | ReadableStreamDefaultReader<Uint8Array>
      | undefined;
    if (!reader) {
      throw new Error("Daemon SSE response body is missing");
    }

    await this.readSseFrames(reader, signal);
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
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    if (!data) {
      return;
    }

    const event = parseDaemonSseEvent(JSON.parse(data) as unknown);
    if (event.type !== "ui.event") {
      return;
    }
    for (const handler of Array.from(this.handlers)) {
      handler(event.event);
    }
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
    core: {
      abortRun(runId): ReturnType<CoreAPI["abortRun"]> {
        return client.abortRun(runId);
      },
      compactSession(compactOptions): ReturnType<CoreAPI["compactSession"]> {
        return client.compactSession(compactOptions);
      },
      connectModel(input): ReturnType<CoreAPI["connectModel"]> {
        return client.connectModel(input);
      },
      executeCommand(invocation): ReturnType<CoreAPI["executeCommand"]> {
        return client.executeCommand(invocation);
      },
      getSnapshot(): ReturnType<CoreAPI["getSnapshot"]> {
        return client.getSnapshot();
      },
      getContextWindowUsage(
        input,
      ): ReturnType<CoreAPI["getContextWindowUsage"]> {
        return client.getContextWindowUsage(input);
      },
      getCurrentModel(): ReturnType<CoreAPI["getCurrentModel"]> {
        return client.getCurrentModel();
      },
      listCommands(query): ReturnType<CoreAPI["listCommands"]> {
        return client.listCommands(query);
      },
      respondInteraction(
        interactionId,
        response,
      ): ReturnType<CoreAPI["respondInteraction"]> {
        return client.respondInteraction(interactionId, response);
      },
      respondPermission(
        requestId,
        response,
      ): ReturnType<CoreAPI["respondPermission"]> {
        return client.respondPermission(requestId, response);
      },
      submitPrompt(text, submitOptions): ReturnType<CoreAPI["submitPrompt"]> {
        return client.submitPrompt(text, submitOptions);
      },
    },
    dispose(): Promise<void> {
      return client.dispose();
    },
  };
}
