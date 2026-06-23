import type { UiEvent } from "ohbaby-sdk";

export const DAEMON_RPC_METHODS = [
  "getSnapshot",
  "initializeClient",
  "getContextWindowUsage",
  "listCommands",
  "submitPrompt",
  "compactSession",
  "archiveSession",
  "getCurrentModel",
  "probeModelContextWindow",
  "connectModel",
  "setSearchApiKey",
  "setPermission",
  "executeCommand",
  "respondPermission",
  "respondInteraction",
  "abortRun",
] as const;

export type DaemonRpcMethod = (typeof DAEMON_RPC_METHODS)[number];

export interface DaemonStartupIntent {
  readonly startupSessionMode?: { readonly type: "continue" | "fresh" };
  readonly resumeSessionId?: string;
  readonly initialPermission?: {
    readonly level: "default" | "full-access";
    readonly mode: "plan" | "auto";
  };
}

export interface DaemonRpcRequest {
  readonly id: string;
  readonly clientId: string;
  readonly method: DaemonRpcMethod;
  readonly params: readonly unknown[];
}

export type DaemonRpcResponse =
  | {
      readonly id: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly id: string;
      readonly ok: false;
      readonly error: {
        readonly message: string;
        readonly name?: string;
      };
    };

export type DaemonSseEvent =
  | {
      readonly type: "hello";
      readonly clientId: string;
    }
  | {
      readonly type: "ui.event";
      readonly event: UiEvent;
    }
  | {
      readonly type: "resync-required";
      readonly maxSeqNum: number;
      readonly minSeqNum: number;
    }
  | {
      readonly type: "error";
      readonly message: string;
    };

const DAEMON_RPC_METHOD_SET = new Set<string>(DAEMON_RPC_METHODS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  message: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(message);
  }
  return value;
}

function requireNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  message: string,
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(message);
  }
  return value as number;
}

export function createDaemonRpcRequest(
  request: DaemonRpcRequest,
): DaemonRpcRequest {
  return {
    clientId: request.clientId,
    id: request.id,
    method: request.method,
    params: [...request.params],
  };
}

export function parseDaemonRpcRequest(value: unknown): DaemonRpcRequest {
  if (!isRecord(value)) {
    throw new TypeError("Daemon rpc request must be an object");
  }

  const id = requireString(value, "id", "Daemon rpc request id is required");
  const clientId = requireString(
    value,
    "clientId",
    "Daemon rpc clientId is required",
  );
  const method = requireString(
    value,
    "method",
    "Daemon rpc method is required",
  );
  if (!DAEMON_RPC_METHOD_SET.has(method)) {
    throw new TypeError(`Unsupported daemon rpc method: ${method}`);
  }

  const params = value.params;
  if (!Array.isArray(params)) {
    throw new TypeError("Daemon rpc params must be an array");
  }

  return {
    clientId,
    id,
    method: method as DaemonRpcMethod,
    params,
  };
}

export function createDaemonRpcSuccess(
  id: string,
  result: unknown,
): DaemonRpcResponse {
  return {
    id,
    ok: true,
    result,
  };
}

export function createDaemonRpcFailure(
  id: string,
  error: unknown,
): DaemonRpcResponse {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : undefined;
  return {
    error: {
      message,
      ...(name ? { name } : {}),
    },
    id,
    ok: false,
  };
}

export function parseDaemonSseEvent(value: unknown): DaemonSseEvent {
  if (!isRecord(value)) {
    throw new TypeError("Daemon SSE event must be an object");
  }

  const type = requireString(
    value,
    "type",
    "Daemon SSE event type is required",
  );
  switch (type) {
    case "hello":
      return {
        clientId: requireString(
          value,
          "clientId",
          "Daemon SSE hello clientId is required",
        ),
        type,
      };
    case "ui.event": {
      const event = value.event;
      if (!isRecord(event) || typeof event.type !== "string") {
        throw new TypeError("Daemon SSE ui.event payload is required");
      }
      return {
        event: event as unknown as UiEvent,
        type,
      };
    }
    case "resync-required":
      return {
        maxSeqNum: requireNonNegativeInteger(
          value,
          "maxSeqNum",
          "Daemon SSE resync maxSeqNum is required",
        ),
        minSeqNum: requireNonNegativeInteger(
          value,
          "minSeqNum",
          "Daemon SSE resync minSeqNum is required",
        ),
        type,
      };
    case "error":
      return {
        message: requireString(
          value,
          "message",
          "Daemon SSE error message is required",
        ),
        type,
      };
    default:
      throw new TypeError(`Unsupported daemon SSE event type: ${type}`);
  }
}
