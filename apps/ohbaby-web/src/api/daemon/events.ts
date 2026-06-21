import type { ConnectionState, WebSseEvent } from "./wire.js";

export interface DaemonEventStreamOptions {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly fetch?: typeof fetch;
  readonly token: string;
}

export interface DaemonEventStreamCallbacks {
  readonly onConnectionState?: (state: ConnectionState) => void;
  readonly onError?: (error: Error) => void;
  readonly onEvent?: (event: {
    readonly id?: number;
    readonly payload: WebSseEvent;
  }) => void | Promise<void>;
}

export interface DaemonEventStream {
  close(): Promise<void>;
  setLastEventId(seqNum: number): void;
  start(callbacks: DaemonEventStreamCallbacks): Promise<void>;
}

interface ParsedSseFrame {
  readonly data?: string;
  readonly id?: string;
}

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;

function requestUrl(baseUrl: string, path: string): string {
  if (baseUrl.length === 0) {
    return path;
  }
  return new URL(path, baseUrl).toString();
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function parseFrame(frame: string): ParsedSseFrame {
  const data: string[] = [];
  let id: string | undefined;
  for (const line of frame.split("\n")) {
    if (line.startsWith("id:")) {
      id = line.slice("id:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  return {
    ...(data.length === 0 ? {} : { data: data.join("\n") }),
    ...(id === undefined ? {} : { id }),
  };
}

function parseEventData(data: string): WebSseEvent {
  const value = JSON.parse(data) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    typeof value.type !== "string"
  ) {
    throw new TypeError("Daemon SSE payload must include a type");
  }
  return value as WebSseEvent;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export class FetchDaemonEventStream implements DaemonEventStream {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string;
  private abortController: AbortController | undefined;
  private lastEventId: string | undefined;
  private loopPromise: Promise<void> | undefined;

  constructor(options: DaemonEventStreamOptions) {
    this.baseUrl = options.baseUrl;
    this.clientId = options.clientId;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.token = options.token;
  }

  setLastEventId(seqNum: number): void {
    this.lastEventId = String(seqNum);
  }

  async start(callbacks: DaemonEventStreamCallbacks): Promise<void> {
    if (this.loopPromise) {
      return this.loopPromise;
    }
    const controller = new AbortController();
    this.abortController = controller;

    let ready = false;
    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: unknown) => void = () => undefined;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    this.loopPromise = this.runLoop(callbacks, controller.signal, {
      reject(error): void {
        if (!ready) {
          ready = true;
          rejectReady(error);
        }
      },
      resolve(): void {
        if (!ready) {
          ready = true;
          resolveReady();
        }
      },
    }).finally(() => {
      if (this.abortController === controller) {
        this.abortController = undefined;
      }
      this.loopPromise = undefined;
    });

    await readyPromise;
  }

  async close(): Promise<void> {
    const pending = this.loopPromise;
    this.abortController?.abort();
    this.abortController = undefined;
    await pending?.catch(() => undefined);
  }

  private async runLoop(
    callbacks: DaemonEventStreamCallbacks,
    signal: AbortSignal,
    ready: {
      reject(error: unknown): void;
      resolve(): void;
    },
  ): Promise<void> {
    let firstAttempt = true;
    let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    while (!signal.aborted) {
      callbacks.onConnectionState?.(
        firstAttempt ? "connecting" : "reconnecting",
      );
      try {
        await this.openOnce(callbacks, signal, ready);
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        callbacks.onError?.(normalized);
        if (firstAttempt) {
          ready.reject(normalized);
        }
        reconnectDelayMs = Math.min(
          reconnectDelayMs * 2,
          MAX_RECONNECT_DELAY_MS,
        );
      }
      firstAttempt = false;
      await delay(reconnectDelayMs, signal);
    }
  }

  private async openOnce(
    callbacks: DaemonEventStreamCallbacks,
    signal: AbortSignal,
    ready: {
      reject(error: unknown): void;
      resolve(): void;
    },
  ): Promise<void> {
    const headers: Record<string, string> = {
      accept: "text/event-stream",
      authorization: `Bearer ${this.token}`,
      "x-ohbaby-client-id": this.clientId,
    };
    if (this.lastEventId !== undefined) {
      headers["last-event-id"] = this.lastEventId;
    }
    const response = await this.fetchImpl(
      requestUrl(this.baseUrl, "/v1/events"),
      {
        headers,
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(`Daemon SSE failed with HTTP ${String(response.status)}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Daemon SSE response body is missing");
    }

    await this.readFrames(reader, callbacks, signal, ready);
  }

  private async readFrames(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    callbacks: DaemonEventStreamCallbacks,
    signal: AbortSignal,
    ready: {
      reject(error: unknown): void;
      resolve(): void;
    },
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      if (signal.aborted) {
        return;
      }
      const read = await reader.read();
      if (read.done) {
        return;
      }
      buffer += decoder.decode(read.value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) {
          break;
        }
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        await this.handleFrame(frame, callbacks, ready);
      }
    }
  }

  private async handleFrame(
    rawFrame: string,
    callbacks: DaemonEventStreamCallbacks,
    ready: {
      reject(error: unknown): void;
      resolve(): void;
    },
  ): Promise<void> {
    const frame = parseFrame(rawFrame);
    if (!frame.data) {
      return;
    }
    const event = parseEventData(frame.data);
    if (event.type === "hello") {
      callbacks.onConnectionState?.("live");
      ready.resolve();
    }
    if (event.type === "ui.event" && frame.id !== undefined) {
      this.lastEventId = frame.id;
    }
    await callbacks.onEvent?.({
      ...(frame.id === undefined ? {} : { id: Number(frame.id) }),
      payload: event,
    });
  }
}
