import {
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_PROTOCOL,
  TERMINAL_TOKEN_PREFIX,
  type TerminalInfo,
} from "ohbaby-sdk";
import { createDaemonHttpClient, type DaemonHttpClient } from "./http.js";
import type { OhbabyBootstrapConfig } from "./wire.js";

/** base64url of the UTF-8 bytes, as the server decodes the token subprotocol. */
export function encodeTokenProtocol(token: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(token))
    binary += String.fromCharCode(byte);
  return `${TERMINAL_TOKEN_PREFIX}${btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "")}`;
}

/** The attach URL on the daemon's origin; the token never goes into it. */
export function terminalSocketUrl(
  baseUrl: string,
  id: string,
  origin?: string,
): string {
  const url = new URL(
    `/v1/terminals/${encodeURIComponent(id)}/attach`,
    baseUrl.length > 0 ? baseUrl : (origin ?? globalThis.location.origin),
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Splits input so each complete `{ type: "input", data }` frame stays within
 * the server's limit in UTF-8 bytes, without splitting a character. Typed keys
 * pass through as one chunk.
 */
export function chunkTerminalInput(
  data: string,
  limit = TERMINAL_MAX_INPUT_BYTES,
): string[] {
  const encoder = new TextEncoder();
  const bytes = (text: string): number => encoder.encode(text).length;
  const envelope = bytes(JSON.stringify({ type: "input", data: "" }));
  if (envelope + bytes(JSON.stringify(data)) - 2 <= limit) return [data];
  const chunks: string[] = [];
  let current = "";
  let used = envelope;
  for (const character of data) {
    // JSON escapes are per character, so frame sizes add up exactly.
    const cost = bytes(JSON.stringify(character)) - 2;
    if (current.length > 0 && used + cost > limit) {
      chunks.push(current);
      current = "";
      used = envelope;
    }
    current += character;
    used += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** What the right panel needs from the daemon's terminals. */
export interface TerminalApi {
  list(): Promise<readonly TerminalInfo[]>;
  create(input: {
    readonly directory: string | null;
    readonly cols: number;
    readonly rows: number;
  }): Promise<TerminalInfo>;
  close(id: string, force: boolean): Promise<void>;
  connect(id: string): WebSocket;
}

/**
 * Terminals belong to the daemon, not to a workspace instance, so this sits
 * beside `UiBackendClient` instead of inside it (architecture §2).
 */
export class TerminalClient implements TerminalApi {
  private readonly http: DaemonHttpClient;

  constructor(
    private readonly config: OhbabyBootstrapConfig,
    private readonly fetchImpl?: typeof fetch,
  ) {
    this.http = createDaemonHttpClient(
      { ...config, directory: undefined },
      fetchImpl,
    );
  }

  async list(): Promise<readonly TerminalInfo[]> {
    const response = await this.http.request<{
      readonly terminals: readonly TerminalInfo[];
    }>("/v1/terminals");
    return response.terminals;
  }

  /** `directory` null opens in the home directory (D3). */
  async create(input: {
    readonly directory: string | null;
    readonly cols: number;
    readonly rows: number;
  }): Promise<TerminalInfo> {
    const http = createDaemonHttpClient(
      { ...this.config, directory: input.directory ?? undefined },
      this.fetchImpl,
    );
    const response = await http.request<{ readonly terminal: TerminalInfo }>(
      "/v1/terminals",
      {
        body: { cols: input.cols, rows: input.rows },
        method: "POST",
      },
    );
    return response.terminal;
  }

  async close(id: string, force: boolean): Promise<void> {
    await this.http.request(
      `/v1/terminals/${encodeURIComponent(id)}${force ? "?force=1" : ""}`,
      { method: "DELETE" },
    );
  }

  connect(id: string): WebSocket {
    return new WebSocket(terminalSocketUrl(this.config.baseUrl, id), [
      TERMINAL_PROTOCOL,
      encodeTokenProtocol(this.config.token),
    ]);
  }
}
