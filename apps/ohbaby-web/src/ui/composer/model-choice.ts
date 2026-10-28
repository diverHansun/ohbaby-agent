import type { UiSettingsModel, UiSettingsModels } from "ohbaby-sdk";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { selectSettings } from "../../store/settings-cache.js";

/** The menu rereads the list when its copy is older than this (06 §3.7). */
export const MODEL_LIST_MAX_AGE_MS = 30_000;

/**
 * The settings model list, loaded once and kept fresh while shown. The model
 * button and the thinking control read the same cached copy.
 */
export function useSettingsModels(
  settings: SettingsLayer,
): UiSettingsModels | undefined {
  const snapshot = useSyncExternalStore(
    useCallback((listener) => settings.cache.subscribe(listener), [settings]),
    () => settings.cache.getSnapshot(),
  );
  useEffect(() => {
    void settings.load("models", { maxAge: MODEL_LIST_MAX_AGE_MS });
    // The button remains visible even when its menu is closed.
    return settings.watch("models");
  }, [settings]);
  return selectSettings(snapshot, "models").data;
}

/**
 * The entry a chat's next turn uses: its own choice while it exists,
 * otherwise the default (00 D1, D10). Incomplete entries stay selected so
 * their configuration error does not silently change the chat's model.
 */
export function resolveModelEntry(
  models: UiSettingsModels | undefined,
  selectedId: string | undefined,
): UiSettingsModel | undefined {
  return (
    models?.models.find((model) => model.id === selectedId) ??
    models?.models.find((model) => model.id === models.active?.id)
  );
}
