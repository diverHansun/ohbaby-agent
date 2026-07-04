import { useSyncExternalStore } from "react";
import type { UiContextWindowUsage, UiGoal } from "ohbaby-sdk";
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

export function selectEffectiveRuntime(state: TuiStoreState): TuiRuntimeStatus {
  if (state.permissions.length > 0) {
    return {
      kind: "waiting-for-permission" as const,
      requestId: state.permissions[0].id,
    };
  }
  return state.runtime;
}

export function selectActiveContextWindowUsage(
  state: TuiStoreState,
): UiContextWindowUsage | null {
  if (!state.activeSessionId) {
    return null;
  }

  return (
    state.contextWindowUsages.find(
      (usage) => usage.sessionId === state.activeSessionId,
    ) ?? null
  );
}

export function selectActiveGoal(state: TuiStoreState): UiGoal | null {
  if (!state.activeSessionId) {
    return null;
  }

  return (
    state.goals.find((goal) => goal.sessionId === state.activeSessionId)
      ?.goal ?? null
  );
}

export function selectRuntimeLabel(state: TuiStoreState): string {
  const runtime = selectEffectiveRuntime(state);

  switch (runtime.kind) {
    case "idle":
      return "idle";
    case "running":
      return runtime.title ? `running: ${trimLabel(runtime.title)}` : "running";
    case "waiting-for-permission":
      return formatPermissionWaitLabel(state);
    case "error":
      return `error: ${runtime.message}`;
  }
}

function formatPermissionWaitLabel(state: TuiStoreState): string {
  const request = state.permissions.at(0);
  const title =
    request?.title === undefined || request.title.trim() === ""
      ? "permission"
      : trimLabel(request.title);

  return state.permissions.length > 1
    ? `waiting: ${title} (+${String(state.permissions.length - 1)})`
    : `waiting: ${title}`;
}

function trimLabel(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const maxLength = 48;

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
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
