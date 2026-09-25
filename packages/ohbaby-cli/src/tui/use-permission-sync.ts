import { useEffect, useRef, useState } from "react";
import { createPermissionSync } from "ohbaby-sdk";
import type {
  CoreAPI,
  PermissionSync,
  PermissionSyncState,
  UiPermissionBinding,
  UiPermissionEvent,
  UiPermissionSnapshot,
} from "ohbaby-sdk";
import type { TuiStore } from "./store/snapshot.js";

const EMPTY: PermissionSyncState = {
  status: "idle",
  binding: null,
  requests: [],
  permissionRevision: 0,
  attempts: 0,
};

/** Local and remote transports use the same independent approval baseline. */
export function usePermissionSync(
  client: CoreAPI,
  store: TuiStore,
  rootSessionId: string | null,
): { readonly state: PermissionSyncState; readonly retry: () => void } {
  const [state, setState] = useState<PermissionSyncState>(EMPTY);
  const [connection, setConnection] = useState(0);
  const currentState = useRef<PermissionSyncState>(EMPTY);
  useEffect(() => {
    let disposed = false;
    let engine: PermissionSync | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
    let bootstrapController: AbortController | undefined;
    let bootstrapAttempts = 0;
    let buffered: UiPermissionEvent[] = [];
    let bufferedBytes = 0;
    let overflowed = false;
    const publish = (next: PermissionSyncState): void => {
      if (disposed) return;
      currentState.current = next;
      setState(next);
      store.setPermissions(next.requests);
    };
    publish(rootSessionId === null ? EMPTY : { ...EMPTY, status: "syncing" });

    const start = (
      binding: UiPermissionBinding,
      generation: string | number,
      baseline?: UiPermissionSnapshot,
    ): void => {
      if (overflowed && baseline && bootstrapAttempts >= 4) {
        publish({
          ...EMPTY,
          status: "error",
          attempts: 4,
          error:
            "Approval synchronization needs a new baseline. Retry to continue.",
        });
        return;
      }
      let firstBaseline = overflowed ? undefined : baseline;
      // Discovery is itself a query attempt. Reusing its result avoids an
      // uncounted query and preserves the four-attempt budget after retries.
      const spent = bootstrapAttempts - (firstBaseline ? 1 : 0);
      engine?.dispose();
      engine = createPermissionSync({
        limits: { maxAttempts: Math.max(1, 4 - spent) },
        query: (current, signal) => {
          if (firstBaseline) {
            const result = firstBaseline;
            firstBaseline = undefined;
            return Promise.resolve(result);
          }
          return client.getPermissionSnapshot({
            rootSessionId: current.rootSessionId,
            permissionEpoch: current.permissionEpoch,
            ...(current.bindingGeneration === 0
              ? {}
              : { bindingGeneration: current.bindingGeneration }),
            signal,
          });
        },
        onChange: publish,
      });
      engine.begin(binding, generation);
      for (const event of buffered) engine.receive(event);
      buffered = [];
      bufferedBytes = 0;
    };

    const receive = (event: UiPermissionEvent): void => {
      if (
        disposed ||
        (event.rootSessionId !== null && event.rootSessionId !== rootSessionId)
      )
        return;
      if (
        event.type === "permission.resync-required" &&
        event.connectionGeneration !== undefined
      ) {
        const binding = {
          permissionEpoch: event.permissionEpoch,
          rootSessionId,
          bindingGeneration: event.bindingGeneration ?? 0,
        };
        if (engine) engine.begin(binding, event.connectionGeneration);
        else {
          bootstrapAttempts = 0;
          start(binding, event.connectionGeneration);
        }
        bootstrapController?.abort();
        clearTimeout(bootstrapTimer);
        return;
      }
      if (engine) {
        engine.receive(event);
        return;
      }
      const size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (buffered.length >= 1024 || bufferedBytes + size > 2 * 1024 * 1024) {
        overflowed = true;
        buffered = [];
        bufferedBytes = 0;
        return;
      }
      if (!overflowed) {
        buffered.push(event);
        bufferedBytes += size;
      }
    };
    const unsubscribe = client.subscribePermissionEvents(receive, () => {
      if (disposed || currentState.current.status === "unavailable") return;
      engine?.disconnect();
      publish({ ...(engine?.getState() ?? EMPTY), status: "syncing" });
      reconnectTimer = setTimeout(() => {
        if (!disposed) setConnection((value) => value + 1);
      }, 0);
    });

    const isBootstrapObsolete = (): boolean => disposed || engine !== undefined;
    const bootstrap = async (): Promise<void> => {
      if (disposed || engine || rootSessionId === null) return;
      bootstrapAttempts += 1;
      const controller = new AbortController();
      bootstrapController = controller;
      const timeout = setTimeout(() => {
        controller.abort();
      }, 10_000);
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            reject(new Error("Approval synchronization timed out."));
          },
          { once: true },
        );
      });
      try {
        const [baseline, index] = await Promise.race([
          Promise.all([
            client.getPermissionSnapshot({
              rootSessionId,
              signal: controller.signal,
            }),
            client.getSessionIndex(),
          ]),
          aborted,
        ]);
        if (isBootstrapObsolete()) return;
        const selected = index.find((session) => session.id === rootSessionId);
        if (!selected || selected.parentId || selected.isSubagent) {
          publish({
            ...EMPTY,
            status: "error",
            error: "Return to a main session to approve requests.",
          });
          return;
        }
        start(
          {
            permissionEpoch: baseline.permissionEpoch,
            rootSessionId,
            bindingGeneration: baseline.bindingGeneration ?? 0,
          },
          connection,
          baseline,
        );
      } catch (error) {
        if (isBootstrapObsolete()) return;
        const unavailable =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "PERMISSION_UNAVAILABLE";
        if (!unavailable && bootstrapAttempts < 4) {
          bootstrapTimer = setTimeout(
            () => {
              void bootstrap();
            },
            [100, 250, 500][bootstrapAttempts - 1],
          );
        } else {
          publish({
            ...EMPTY,
            attempts: bootstrapAttempts,
            status: unavailable ? "unavailable" : "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        clearTimeout(timeout);
        // A failed sibling (metadata) must not leave this attempt
        // querying after the retry starts or the root becomes unavailable.
        controller.abort();
        if (bootstrapController === controller) bootstrapController = undefined;
      }
    };
    void bootstrap();
    return (): void => {
      disposed = true;
      clearTimeout(bootstrapTimer);
      clearTimeout(reconnectTimer);
      bootstrapController?.abort();
      unsubscribe();
      engine?.dispose();
    };
  }, [client, store, rootSessionId, connection]);
  return {
    state,
    retry: (): void => {
      if (currentState.current.status === "unavailable") return;
      setConnection((value) => value + 1);
    },
  };
}
