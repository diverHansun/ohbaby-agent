import {
  applySessionChange,
  sameSessionGeneration,
  type UiSessionScope,
  type UiSessionView,
  type UiSessionRecoveryEvent,
} from "./session-view.js";

export interface SessionSyncState {
  readonly status: "idle" | "syncing" | "ready" | "error";
  readonly scope: UiSessionScope | null;
  readonly view?: UiSessionView;
  readonly attempts: number;
  readonly error?: string;
}
export interface SessionSyncOptions {
  readonly query: (
    scope: UiSessionScope,
    signal: AbortSignal,
  ) => Promise<UiSessionView>;
  readonly onChange?: (state: SessionSyncState) => void;
  readonly limits?: {
    readonly timeoutMs?: number;
    readonly maxAttempts?: number;
    readonly retryDelaysMs?: readonly number[];
    readonly maxBufferedEvents?: number;
    readonly maxBufferedBytes?: number;
  };
}
export interface SessionSync {
  getState(): SessionSyncState;
  begin(scope: UiSessionScope | null, connection: string | number): void;
  receive(event: UiSessionRecoveryEvent): void;
  resync(): void;
  retry(): void;
  disconnect(): void;
  dispose(): void;
}
/** One bounded recovery cycle per connection and scope, shared by all frontends. */
export function createSessionSync(options: SessionSyncOptions): SessionSync {
  let state: SessionSyncState = { status: "idle", scope: null, attempts: 0 };
  let connection: string | number | undefined;
  let connected = false;
  let disposed = false;
  let ticket = 0;
  let controller: AbortController | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let buffer: UiSessionRecoveryEvent[] = [];
  let bytes = 0;
  let rapidFailures = 0;
  let healthySince: number | undefined;
  // IDs are opaque: remember known invalid or replaced generations, while an
  // unseen ID can indicate a new failure. Bound retained transport history.
  const retiredGenerations = new Set<string>();
  function retireGeneration(generation: string): void {
    retiredGenerations.add(generation);
    if (retiredGenerations.size > 64) {
      const oldest = retiredGenerations.values().next().value;
      if (oldest !== undefined) retiredGenerations.delete(oldest);
    }
  }
  const limits = options.limits;
  const maxAttempts = limits?.maxAttempts ?? 4;
  function publish(patch: Partial<SessionSyncState>): void {
    state = { ...state, ...patch };
    options.onChange?.(state);
  }
  function clearBuffer(): void {
    buffer = [];
    bytes = 0;
  }
  function cancel(): void {
    ++ticket;
    controller?.abort();
    controller = undefined;
    clearTimeout(timeout);
    clearTimeout(retryTimer);
    timeout = undefined;
    retryTimer = undefined;
  }
  function eligible(): boolean {
    return !disposed && connected && state.scope !== null;
  }
  function fail(error: unknown): void {
    healthySince = undefined;
    if (retryTimer) return;
    cancel();
    if (!eligible()) return;
    const message = error instanceof Error ? error.message : String(error);
    if (state.attempts >= maxAttempts) {
      clearBuffer();
      publish({ status: "error", error: message });
      return;
    }
    publish({ status: "syncing", error: message });
    const delays = limits?.retryDelaysMs ?? [100, 250, 500];
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined;
        query();
      },
      delays[Math.max(0, Math.min(state.attempts - 1, delays.length - 1))] ?? 0,
    );
  }
  function matches(
    version: { runtimeEpoch: string; sessionId: string },
    bindingGeneration?: number,
  ): boolean {
    return (
      version.sessionId === state.scope?.sessionId &&
      (state.scope.runtimeEpoch === undefined ||
        state.scope.runtimeEpoch === version.runtimeEpoch) &&
      (state.scope.bindingGeneration === undefined ||
        state.scope.bindingGeneration === bindingGeneration)
    );
  }
  function install(view: UiSessionView): void {
    if (retiredGenerations.has(view.version.viewGeneration)) {
      fail(new Error("Session baseline generation is unavailable"));
      return;
    }
    if (
      !matches(view.version, view.bindingGeneration) ||
      view.session.id !== view.version.sessionId ||
      !Number.isSafeInteger(view.version.sessionRevision) ||
      view.version.sessionRevision < 0
    ) {
      fail(new Error("Invalid session baseline scope"));
      return;
    }
    if (
      state.view &&
      sameSessionGeneration(state.view.version, view.version) &&
      view.version.sessionRevision < state.view.version.sessionRevision
    ) {
      fail(new Error("Stale session baseline"));
      return;
    }
    let next = view;
    for (const event of buffer) {
      if (event.type === "session.unavailable") {
        fail(new Error(event.reason));
        return;
      }
      if (!sameSessionGeneration(next.version, event.version)) {
        clearBuffer();
        fail(
          new Error("Session generation changed while reading the baseline"),
        );
        return;
      }
      const applied = applySessionChange(next, event);
      if (!applied) {
        fail(new Error("Session event sequence has a gap"));
        return;
      }
      next = applied;
    }
    if (
      state.view &&
      state.view.version.viewGeneration !== next.version.viewGeneration
    ) {
      retireGeneration(state.view.version.viewGeneration);
    }
    clearBuffer();
    healthySince ??= Date.now();
    publish({ view: next, status: "ready", attempts: 0, error: undefined });
  }
  function query(): void {
    if (!eligible() || controller || retryTimer || !state.scope) return;
    if (state.attempts >= maxAttempts) {
      publish({
        status: "error",
        error: "Session recovery retry limit reached",
      });
      return;
    }
    const active = new AbortController();
    const current = ++ticket;
    const scope = state.scope;
    controller = active;
    publish({ status: "syncing", attempts: state.attempts + 1 });
    timeout = setTimeout(() => {
      if (current === ticket) fail(new Error("Session baseline timed out"));
    }, limits?.timeoutMs ?? 10_000);
    Promise.resolve()
      .then(() =>
        current === ticket && eligible() && !active.signal.aborted
          ? options.query(scope, active.signal)
          : undefined,
      )
      .then(
        (view) => {
          if (current !== ticket || !eligible() || view === undefined) return;
          clearTimeout(timeout);
          timeout = undefined;
          controller = undefined;
          install(view);
        },
        (error: unknown) => {
          if (current === ticket && eligible()) fail(error);
        },
      );
  }
  // A successful read is not proof that a persistent producer fault healed.
  // Keep a separate short-term budget across successful rebuilds and reconnects.
  function invalidateReadyView(): boolean {
    if (healthySince !== undefined && Date.now() - healthySince >= 1_000)
      rapidFailures = 0;
    healthySince = undefined;
    rapidFailures += 1;
    if (rapidFailures >= maxAttempts) {
      cancel();
      clearBuffer();
      publish({
        status: "error",
        error:
          "Session recovery repeatedly became unavailable; retry after the source recovers",
      });
      return false;
    }
    publish({ status: "syncing" });
    const delay = [0, 100, 250][Math.min(rapidFailures - 1, 2)] ?? 250;
    if (delay > 0)
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        query();
      }, delay);
    return true;
  }
  function resync(): void {
    if (eligible() && state.status !== "error") {
      publish({ status: "syncing" });
      query();
    }
  }
  return {
    getState: () => state,
    begin(scope, nextConnection): void {
      if (disposed) return;
      const same = sameScope(state.scope, scope);
      connected = true;
      if (same && connection === nextConnection) {
        resync();
        return;
      }
      cancel();
      clearBuffer();
      connection = nextConnection;
      healthySince = undefined;
      if (!same) {
        retiredGenerations.clear();
        rapidFailures = 0;
        healthySince = undefined;
      }
      if (same && rapidFailures >= maxAttempts) {
        publish({ status: "error" });
        return;
      }
      publish({
        scope,
        status: scope ? "syncing" : "idle",
        view: same ? state.view : undefined,
        attempts: 0,
        error: undefined,
      });
      query();
    },
    receive(event): void {
      if (!eligible() || state.status === "error") return;
      const version = event.type === "session.changed" ? event.version : event;
      if (!matches(version, event.bindingGeneration)) return;
      if (event.type === "session.unavailable") {
        if (
          event.viewGeneration &&
          retiredGenerations.has(event.viewGeneration)
        )
          return;
        if (event.viewGeneration) retireGeneration(event.viewGeneration);
        // A notification says the installed view is unhealthy. A baseline
        // already in flight is the recovery attempt, so let it finish.
        if (state.status === "syncing" || controller || retryTimer) return;
        clearBuffer();
        if (invalidateReadyView()) resync();
        return;
      }
      if (state.status === "ready" && state.view) {
        const next = applySessionChange(state.view, event);
        if (next) {
          publish({ view: next });
          return;
        }
        if (!invalidateReadyView()) return;
      }
      const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (
        buffer.length + 1 > (limits?.maxBufferedEvents ?? 1024) ||
        bytes + size > (limits?.maxBufferedBytes ?? 8 * 1024 * 1024)
      ) {
        clearBuffer();
        fail(new Error("Session event buffer overflow"));
        return;
      }
      buffer.push(event);
      bytes += size;
      resync();
    },
    resync,
    retry(): void {
      if (!eligible()) return;
      cancel();
      clearBuffer();
      rapidFailures = 0;
      healthySince = undefined;
      publish({ attempts: 0, status: "syncing", error: undefined });
      query();
    },
    disconnect(): void {
      connected = false;
      healthySince = undefined;
      cancel();
      clearBuffer();
      publish({ status: state.scope ? "syncing" : "idle" });
    },
    dispose(): void {
      disposed = true;
      connected = false;
      cancel();
      clearBuffer();
    },
  };
}
function sameScope(
  a: UiSessionScope | null,
  b: UiSessionScope | null,
): boolean {
  return (
    a?.sessionId === b?.sessionId &&
    a?.runtimeEpoch === b?.runtimeEpoch &&
    a?.bindingGeneration === b?.bindingGeneration
  );
}
