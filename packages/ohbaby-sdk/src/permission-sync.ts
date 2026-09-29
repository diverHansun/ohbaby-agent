import type {
  UiPermissionBinding,
  UiPermissionSnapshot,
  UiPermissionEvent,
} from "./permission.js";
import type { UiPermissionRequest } from "./snapshot.js";

export type PermissionSyncEvent = UiPermissionEvent;
export interface PermissionSyncState {
  readonly status: "idle" | "syncing" | "ready" | "error" | "unavailable";
  readonly binding: UiPermissionBinding | null;
  readonly requests: readonly UiPermissionRequest[];
  readonly permissionRevision: number;
  readonly attempts: number;
  readonly error?: string;
}
export interface PermissionSyncOptions {
  readonly query: (
    binding: UiPermissionBinding,
    signal: AbortSignal,
  ) => Promise<UiPermissionSnapshot>;
  readonly onChange?: (state: PermissionSyncState) => void;
  /** Internal/test resource limits; these are not user settings. */
  readonly limits?: {
    readonly maxAttempts?: number;
    readonly timeoutMs?: number;
    readonly retryDelaysMs?: readonly number[];
    readonly maxBufferedEvents?: number;
    readonly maxBufferedBytes?: number;
  };
}
export interface PermissionSync {
  getState(): PermissionSyncState;
  begin(
    binding: UiPermissionBinding,
    connectionGeneration: string | number,
  ): void;
  receive(event: PermissionSyncEvent): void;
  disconnect(): void;
  resync(): void;
  retry(): void;
  dispose(): void;
}

function sameBinding(
  left: UiPermissionBinding | null,
  right: UiPermissionBinding,
): boolean {
  return (
    left?.permissionEpoch === right.permissionEpoch &&
    left.rootSessionId === right.rootSessionId &&
    left.bindingGeneration === right.bindingGeneration
  );
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function unavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "PERMISSION_UNAVAILABLE"
  );
}
function sorted(
  requests: readonly UiPermissionRequest[],
): readonly UiPermissionRequest[] {
  return [...requests].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

/** Approval recovery is independent of chat snapshots and global event cursors. */
export function createPermissionSync(
  options: PermissionSyncOptions,
): PermissionSync {
  const maxAttempts = options.limits?.maxAttempts ?? 4;
  const timeoutMs = options.limits?.timeoutMs ?? 10_000;
  const delays = options.limits?.retryDelaysMs ?? [100, 250, 500];
  const maxEvents = options.limits?.maxBufferedEvents ?? 1024;
  const maxBytes = options.limits?.maxBufferedBytes ?? 2 * 1024 * 1024;
  let state: PermissionSyncState = {
    status: "idle",
    binding: null,
    requests: [],
    permissionRevision: 0,
    attempts: 0,
  };
  let connection: string | number | undefined;
  let connected = false;
  let disposed = false;
  let ticket = 0;
  let controller: AbortController | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let buffer: PermissionSyncEvent[] = [];
  let bufferedBytes = 0;

  function publish(patch: Partial<PermissionSyncState>): void {
    state = { ...state, ...patch };
    options.onChange?.(state);
  }
  function clearBuffer(): void {
    buffer = [];
    bufferedBytes = 0;
  }
  function cancelQuery(): void {
    ticket += 1;
    controller?.abort();
    controller = undefined;
    clearTimeout(timeout);
    timeout = undefined;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  function eligible(): boolean {
    return (
      !disposed &&
      connected &&
      state.binding?.rootSessionId !== null &&
      state.binding !== null
    );
  }
  function matches(event: {
    permissionEpoch: string;
    rootSessionId: string | null;
    bindingGeneration?: number;
  }): boolean {
    return (
      state.binding?.permissionEpoch === event.permissionEpoch &&
      state.binding.rootSessionId === event.rootSessionId &&
      (event.bindingGeneration === undefined ||
        event.bindingGeneration === state.binding.bindingGeneration)
    );
  }
  function nextState(
    event: PermissionSyncEvent,
    requests: readonly UiPermissionRequest[],
    revision: number,
  ):
    | { requests: readonly UiPermissionRequest[]; permissionRevision: number }
    | undefined {
    if (
      event.type === "permission.unavailable" ||
      event.type === "permission.resync-required"
    )
      return undefined;
    if (event.permissionRevision <= revision)
      return { requests, permissionRevision: revision };
    if (event.permissionRevision !== revision + 1) return undefined;
    if (event.type === "permission.requested") {
      if (event.request.rootSessionId !== state.binding?.rootSessionId)
        return undefined;
      const existing = requests.find((item) => item.id === event.request.id);
      if (existing) return undefined;
      return {
        requests: sorted([...requests, event.request]),
        permissionRevision: event.permissionRevision,
      };
    }
    return {
      requests: requests.filter((item) => item.id !== event.requestId),
      permissionRevision: event.permissionRevision,
    };
  }
  function fail(error: unknown): void {
    cancelQuery();
    if (unavailable(error)) {
      clearBuffer();
      publish({ status: "unavailable", error: message(error) });
      return;
    }
    if (!eligible()) return;
    if (state.attempts >= maxAttempts) {
      clearBuffer();
      publish({
        status: "error",
        error: `Permission synchronization failed: ${message(error)}`,
      });
      return;
    }
    publish({ status: "syncing", error: message(error) });
    const delay = delays[Math.min(state.attempts - 1, delays.length - 1)] ?? 0;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      query();
    }, delay);
  }
  function install(snapshot: UiPermissionSnapshot): void {
    if (
      !matches(snapshot) ||
      !Number.isSafeInteger(snapshot.permissionRevision) ||
      snapshot.permissionRevision < state.permissionRevision ||
      new Set(snapshot.requests.map((item) => item.id)).size !==
        snapshot.requests.length ||
      snapshot.requests.some(
        (item) => item.rootSessionId !== state.binding?.rootSessionId,
      )
    ) {
      fail(new Error("Permission snapshot scope or revision is invalid"));
      return;
    }
    let candidate = {
      requests: sorted(snapshot.requests),
      permissionRevision: snapshot.permissionRevision,
    };
    for (const event of buffer) {
      const next = nextState(
        event,
        candidate.requests,
        candidate.permissionRevision,
      );
      if (!next) {
        fail(new Error("Permission event sequence has a gap"));
        return;
      }
      candidate = next;
    }
    clearBuffer();
    publish({ ...candidate, status: "ready", error: undefined });
  }
  function query(): void {
    if (!eligible() || controller || retryTimer || !state.binding) return;
    if (state.attempts >= maxAttempts) {
      publish({
        status: "error",
        error: "Permission synchronization retry limit reached",
      });
      return;
    }
    const current = ++ticket;
    const scope = state.binding;
    const active = new AbortController();
    controller = active;
    publish({
      status: "syncing",
      attempts: state.attempts + 1,
      error: undefined,
    });
    timeout = setTimeout(() => {
      if (current === ticket) fail(new Error("Permission snapshot timed out"));
    }, timeoutMs);
    let pending: Promise<UiPermissionSnapshot>;
    try {
      pending = options.query(scope, active.signal);
    } catch (error) {
      fail(error);
      return;
    }
    void pending.then(
      (snapshot) => {
        if (current !== ticket || !eligible()) return;
        clearTimeout(timeout);
        timeout = undefined;
        controller = undefined;
        install(snapshot);
      },
      (error: unknown) => {
        if (current === ticket && eligible()) fail(error);
      },
    );
  }
  function resync(): void {
    if (
      !eligible() ||
      state.status === "unavailable" ||
      state.status === "error"
    )
      return;
    if (!controller && !retryTimer) {
      publish({ status: "syncing" });
      query();
    }
  }
  return {
    getState: () => state,
    begin(binding, connectionGeneration): void {
      if (disposed) return;
      if (
        state.status === "unavailable" &&
        state.binding?.permissionEpoch === binding.permissionEpoch &&
        state.binding.rootSessionId === binding.rootSessionId
      )
        return;
      const unchanged =
        connection === connectionGeneration &&
        sameBinding(state.binding, binding);
      connected = true;
      if (unchanged) {
        // A receipt or repeated hello confirms the live scope; it does not
        // invalidate a baseline that is already synchronized.
        if (state.status === "ready") return;
        resync();
        return;
      }
      const preserve = sameBinding(state.binding, binding);
      cancelQuery();
      clearBuffer();
      connection = connectionGeneration;
      publish({
        binding: {
          permissionEpoch: binding.permissionEpoch,
          rootSessionId: binding.rootSessionId,
          bindingGeneration: binding.bindingGeneration,
        },
        status: binding.rootSessionId === null ? "idle" : "syncing",
        attempts: 0,
        permissionRevision: preserve ? state.permissionRevision : 0,
        requests: preserve ? state.requests : [],
        error: undefined,
      });
      query();
    },
    receive(event): void {
      if (!eligible()) return;
      if (
        event.type === "permission.unavailable" &&
        event.rootSessionId === null &&
        event.permissionEpoch === state.binding?.permissionEpoch &&
        (event.bindingGeneration === undefined ||
          event.bindingGeneration === state.binding.bindingGeneration)
      ) {
        fail(
          Object.assign(new Error(event.reason), {
            code: "PERMISSION_UNAVAILABLE",
          }),
        );
        return;
      }
      if (!matches(event)) return;
      if (event.type === "permission.resync-required") {
        resync();
        return;
      }
      if (event.type === "permission.unavailable") {
        fail(
          Object.assign(new Error(event.reason), {
            code: "PERMISSION_UNAVAILABLE",
          }),
        );
        return;
      }
      if (state.status === "unavailable" || state.status === "error") return;
      if (state.status === "ready") {
        const next = nextState(event, state.requests, state.permissionRevision);
        if (next) {
          publish(next);
          return;
        }
        publish({ status: "syncing" });
      }
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (buffer.length + 1 > maxEvents || bufferedBytes + bytes > maxBytes) {
        clearBuffer();
        fail(new Error("Permission event buffer overflow"));
        return;
      }
      buffer.push(event);
      bufferedBytes += bytes;
      resync();
    },
    disconnect(): void {
      if (disposed) return;
      connected = false;
      cancelQuery();
      clearBuffer();
      publish({
        status:
          state.status === "unavailable"
            ? "unavailable"
            : state.binding?.rootSessionId
              ? "syncing"
              : "idle",
      });
    },
    resync,
    retry(): void {
      if (!eligible() || state.status === "unavailable") return;
      cancelQuery();
      clearBuffer();
      publish({ attempts: 0, status: "syncing", error: undefined });
      query();
    },
    dispose(): void {
      if (disposed) return;
      connected = false;
      cancelQuery();
      clearBuffer();
      disposed = true;
      publish({ status: "idle", requests: [] });
    },
  };
}
