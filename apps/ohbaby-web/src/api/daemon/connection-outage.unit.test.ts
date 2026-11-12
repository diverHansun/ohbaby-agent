import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOhbabyWebStore } from "../../store/store.js";
import { CONNECTION_LOST_AFTER_MS, ClientSync } from "./client-sync.js";
import {
  DaemonEventsRejectedError,
  type DaemonEventStreamCallbacks,
  type FetchDaemonEventStream,
} from "./events.js";
import type { DaemonHttpClient } from "./http.js";

/** A connection whose transport the test drives by hand. */
function connection(): {
  readonly store: ReturnType<typeof createOhbabyWebStore>;
  readonly sync: ClientSync;
  readonly transport: () => DaemonEventStreamCallbacks;
  readonly wake: ReturnType<typeof vi.fn>;
} {
  const store = createOhbabyWebStore();
  let callbacks: DaemonEventStreamCallbacks | undefined;
  const wake = vi.fn();
  const events = {
    start: (next: DaemonEventStreamCallbacks): Promise<void> => {
      callbacks = next;
      return Promise.resolve();
    },
    close: (): Promise<void> => Promise.resolve(),
    setLastEventId: (): void => undefined,
    wake,
  } as unknown as FetchDaemonEventStream;
  const http = {
    registerClient: () =>
      Promise.resolve({
        ok: true,
        clientId: "client",
        permissionEpoch: "epoch",
        bindingGeneration: 1,
        rootSessionId: null,
      }),
  } as unknown as DaemonHttpClient;
  const sync = new ClientSync({
    config: { baseUrl: "", clientId: "client", token: "token" },
    events,
    http,
    store,
    hooks: {
      onScopeReady: (): void => undefined,
      onCommandCatalogUpdated: (): void => undefined,
    },
  });
  return {
    store,
    sync,
    wake,
    transport: (): DaemonEventStreamCallbacks => {
      if (!callbacks) throw new Error("not connected");
      return callbacks;
    },
  };
}

describe("connection outage notice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says the connection is lost only after it stays down, and clears on return", async () => {
    const { store, sync, transport } = connection();
    await sync.connect();
    transport().onConnectionState?.("live");
    transport().onConnectionState?.("reconnecting");
    vi.advanceTimersByTime(CONNECTION_LOST_AFTER_MS - 1);
    expect(store.getSnapshot().connectionNotice).toBeNull();
    // A hello that drops again before the open conversation re-syncs is not
    // a recovery; the clock keeps running.
    store.setSessionSync({ status: "syncing", scope: null, attempts: 1 });
    transport().onConnectionState?.("live");
    transport().onConnectionState?.("reconnecting");
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot().connectionNotice).toBe("lost");
    // Live, but the conversation is still re-syncing: keep the notice.
    store.setSessionSync({ status: "syncing", scope: null, attempts: 1 });
    transport().onConnectionState?.("live");
    expect(store.getSnapshot().connectionNotice).toBe("lost");
    store.setSessionSync({ status: "idle", scope: null, attempts: 0 });
    expect(store.getSnapshot().connectionNotice).toBeNull();
    await sync.close();
  });

  it("leaves a brief drop to the header", async () => {
    const { store, sync, transport } = connection();
    await sync.connect();
    transport().onConnectionState?.("live");
    transport().onConnectionState?.("reconnecting");
    vi.advanceTimersByTime(3_000);
    transport().onConnectionState?.("live");
    vi.advanceTimersByTime(CONNECTION_LOST_AFTER_MS);
    expect(store.getSnapshot().connectionNotice).toBeNull();
    await sync.close();
  });

  it("asks for a refresh at once when the daemon restarted, and wakes on demand", async () => {
    const { store, sync, transport, wake } = connection();
    await sync.connect();
    transport().onConnectionState?.("live");
    transport().onConnectionState?.("reconnecting");
    transport().onError?.(new DaemonEventsRejectedError(401));
    expect(store.getSnapshot().connectionNotice).toBe("restarted");
    vi.advanceTimersByTime(CONNECTION_LOST_AFTER_MS);
    expect(store.getSnapshot().connectionNotice).toBe("restarted");
    sync.reconnectNow();
    expect(wake).toHaveBeenCalledOnce();
    await sync.close();
    expect(store.getSnapshot().connectionNotice).toBeNull();
  });

  it("keeps the restart verdict when it replaces a lost connection", async () => {
    const { store, sync, transport } = connection();
    await sync.connect();
    transport().onConnectionState?.("live");
    transport().onConnectionState?.("reconnecting");
    vi.advanceTimersByTime(CONNECTION_LOST_AFTER_MS);
    expect(store.getSnapshot().connectionNotice).toBe("lost");
    transport().onError?.(new DaemonEventsRejectedError(409));
    expect(store.getSnapshot().connectionNotice).toBe("restarted");
    vi.advanceTimersByTime(CONNECTION_LOST_AFTER_MS * 2);
    expect(store.getSnapshot().connectionNotice).toBe("restarted");
    await sync.close();
  });
});
