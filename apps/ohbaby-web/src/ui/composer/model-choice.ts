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
 * The entry a chat's next turn uses: its own choice while that entry is
 * still complete, otherwise the default (00 D1, D10). `undefined` until the
 * list loads or when no model is usable.
 */
export function resolveModelEntry(
  models: UiSettingsModels | undefined,
  selectedId: string | undefined,
): UiSettingsModel | undefined {
  const complete = models?.models.filter(
    (model) => model.configurationComplete,
  );
  return (
    complete?.find((model) => model.id === selectedId) ??
    complete?.find((model) => model.id === models?.active?.id)
  );
}
