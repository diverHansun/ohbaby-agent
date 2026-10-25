import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import {
  INSTANCE_KINDS,
  selectSettings,
  type SettingsData,
  type SettingsKind,
  type SettingsResource,
} from "../../store/settings-cache.js";

/**
 * One settings resource for a section. While `visible`, it is read on entry
 * and watched, so change events and window focus reread it (06 §3.7).
 */
export function useSettingsResource<K extends SettingsKind>(
  settings: SettingsLayer,
  kind: K,
  visible: boolean,
): SettingsResource<SettingsData[K]> & {
  readonly reload: () => Promise<void>;
} {
  const snapshot = useSyncExternalStore(
    useCallback((listener) => settings.cache.subscribe(listener), [settings]),
    () => settings.cache.getSnapshot(),
  );
  const directory = INSTANCE_KINDS.has(kind)
    ? (settings.directory ?? undefined)
    : undefined;
  useEffect(() => {
    if (!visible) return;
    void settings.load(kind, { force: true });
    return settings.watch(kind);
  }, [settings, kind, visible, directory]);
  const reload = useCallback(
    () => settings.load(kind, { force: true }),
    [settings, kind],
  );
  return { ...selectSettings(snapshot, kind, directory), reload };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
