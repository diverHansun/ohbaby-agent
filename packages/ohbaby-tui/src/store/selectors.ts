import { useSyncExternalStore } from "react";
import type {
  TuiInteractionRequest,
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

export function selectRuntimeLabel(state: TuiStoreState): string {
  switch (state.runtime.kind) {
    case "idle":
      return "idle";
    case "running":
      return state.runtime.title ?? "running";
    case "waiting-for-permission":
      return "waiting-for-permission";
    case "error":
      return "error";
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
