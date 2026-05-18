import { useSyncExternalStore } from "react";
import type {
  TuiInteractionRequest,
  TuiRuntimeStatus,
  TuiStore,
  TuiStoreState,
} from "./snapshot.js";

export function selectActiveDialog(
  state: TuiStoreState,
): TuiInteractionRequest | undefined {
  return state.interactions[0];
}

export function selectHasActivePermission(state: TuiStoreState): boolean {
  return state.permissions.length > 0;
}

export function selectEffectiveRuntime(
  state: TuiStoreState,
): TuiRuntimeStatus {
  if (state.permissions.length > 0) {
    return {
      kind: "waiting-for-permission" as const,
      requestId: state.permissions[0].id,
    };
  }
  return state.runtime;
}

export function selectRuntimeLabel(state: TuiStoreState): string {
  const runtime = selectEffectiveRuntime(state);

  switch (runtime.kind) {
    case "idle":
      return "idle";
    case "running":
      return runtime.title
        ? `${runtime.title} (${runtime.runId})`
        : `running: ${runtime.runId}`;
    case "waiting-for-permission":
      return state.permissions.length > 1
        ? `waiting: ${runtime.requestId} (+${String(state.permissions.length - 1)})`
        : `waiting: ${runtime.requestId}`;
    case "error":
      return `error: ${runtime.message}`;
  }
}

export function useTuiStoreSelector<TSelected>(
  store: TuiStore,
  selector: (state: TuiStoreState) => TSelected,
): TSelected {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}
