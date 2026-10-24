import { useMemo, useSyncExternalStore } from "react";
import type { OhbabyWebRuntime } from "../../runtime/index.js";
import { selectViewModel } from "./selectors.js";
import { useSessionSyncBanner } from "./use-session-sync-banner.js";

/** Subscribes the conversation view to the runtime store and workspace snapshot. */
export function useSessionLoad(runtime: OhbabyWebRuntime): {
  readonly storeSnapshot: ReturnType<OhbabyWebRuntime["store"]["getSnapshot"]>;
  readonly view: ReturnType<typeof selectViewModel>;
  readonly workspace: ReturnType<OhbabyWebRuntime["getWorkspaceSnapshot"]>;
  readonly draftScopeKey: string;
  readonly sessionSyncBanner: ReturnType<typeof useSessionSyncBanner>;
  readonly promptRecoveryReminders: ReturnType<
    OhbabyWebRuntime["store"]["getSnapshot"]
  >["unknownPromptRequests"];
} {
  const storeSnapshot = useSyncExternalStore(
    (listener) => runtime.store.subscribe(listener),
    () => runtime.store.getSnapshot(),
    () => runtime.store.getSnapshot(),
  );
  const view = useMemo(() => selectViewModel(storeSnapshot), [storeSnapshot]);
  const sessionSyncBanner = useSessionSyncBanner(storeSnapshot.sessionSync);
  const workspace = useSyncExternalStore(
    (listener) => runtime.subscribeWorkspaces(listener),
    () => runtime.getWorkspaceSnapshot(),
    () => runtime.getWorkspaceSnapshot(),
  );
  return {
    storeSnapshot,
    view,
    workspace,
    draftScopeKey: `${workspace.selectedDirectory ?? "workspace"}:${view.composer.activeSessionId ?? "new"}`,
    sessionSyncBanner,
    promptRecoveryReminders: storeSnapshot.unknownPromptRequests.filter(
      (request) => request.status === "epoch-changed" || !request.submitting,
    ),
  };
}
