/** User terminals belong to the daemon, independently of agent sessions. */
export interface TerminalInfo {
  readonly id: string;
  readonly directory: string;
  readonly title: string;
  readonly shell: string;
  readonly createdAt: number;
  readonly state: "running" | "closing" | "close_failed";
  readonly error?: string;
}

export type TerminalClientMessage =
  | { readonly type: "input"; readonly data: string }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number };

export type TerminalServerMessage =
  | {
      readonly type: "snapshot";
      readonly data: string;
      readonly cols: number;
      readonly rows: number;
    }
  | { readonly type: "output"; readonly data: string }
  | {
      readonly type: "exit";
      readonly exitCode: number;
      readonly signal?: number;
    };

export const TERMINAL_PROTOCOL = "ohbaby.terminal.v1";
export const TERMINAL_TOKEN_PREFIX = "ohbaby.bearer.";
export const TERMINAL_MAX_INPUT_BYTES = 65_536;
export const TERMINAL_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
export const TERMINAL_ERROR_CODES = {
  INVALID_REQUEST: "TERMINAL_INVALID_REQUEST",
  LIMIT_REACHED: "TERMINAL_LIMIT_REACHED",
  UNAVAILABLE: "TERMINAL_UNAVAILABLE",
  BUSY: "TERMINAL_BUSY",
  NOT_FOUND: "TERMINAL_NOT_FOUND",
  CLOSE_FAILED: "TERMINAL_CLOSE_FAILED",
  STOPPING: "TERMINAL_STOPPING",
  LOOPBACK_ONLY: "TERMINAL_LOOPBACK_ONLY",
} as const;
export const TERMINAL_CLOSE_CODES = {
  NORMAL: 1000,
  UNAUTHORIZED: 4401,
  NOT_FOUND: 4404,
  OVERFLOW: 4408,
} as const;
