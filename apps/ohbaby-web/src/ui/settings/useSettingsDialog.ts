import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { selectSettings } from "../../store/settings-cache.js";
import {
  readLastSection,
  rememberSection,
  type SettingsSection,
} from "./sections.js";

export interface SettingsDialogState {
  /** Mounted once opened; closing only hides it, keeping edits (D2). */
  readonly mounted: boolean;
  readonly open: boolean;
  readonly section: SettingsSection;
  /** Phones show either the section list or one section (03 §5). */
  readonly pane: "nav" | "section";
  /** Changing it remounts the sections, dropping a half-done edit. */
  readonly resetKey: number;
  /** Gets focus back on close: the trigger, else what had focus on open. */
  readonly returnFocus: HTMLElement | null;
}

export interface SettingsDialogControls {
  readonly state: SettingsDialogState;
  /**
   * `fromDraft`: a draft send found no model. Models opens on its list, and
   * once a default model appears the dialog closes back to the draft (06 §3.7).
   */
  readonly open: (options?: {
    readonly section?: SettingsSection;
    readonly fromDraft?: boolean;
    /** Safari does not focus a clicked button, so callers pass it. */
    readonly trigger?: HTMLElement;
  }) => void;
  readonly close: () => void;
  readonly selectSection: (section: SettingsSection) => void;
  readonly showNav: () => void;
}

export function useSettingsDialog(
  settings: SettingsLayer,
): SettingsDialogControls {
  const [state, setState] = useState<SettingsDialogState>(() => ({
    mounted: false,
    open: false,
    section: readLastSection(),
    pane: "nav",
    resetKey: 0,
    returnFocus: null,
  }));
  // Set while a draft send waits for a default model; the user closing clears it.
  const fromDraft = useRef(false);
  const lastActive = useRef<string | null | undefined>(undefined);

  const close = useCallback((): void => {
    fromDraft.current = false;
    setState((current) => ({ ...current, open: false }));
  }, []);

  const open = useCallback<SettingsDialogControls["open"]>(
    (options = {}) => {
      fromDraft.current = options.fromDraft === true;
      const models = selectSettings(
        settings.cache.getSnapshot(),
        "models",
      ).data;
      // From the draft there is no default yet: any default that shows up closes.
      lastActive.current = models
        ? (models.active?.id ?? null)
        : options.fromDraft
          ? null
          : undefined;
      setState((current) => {
        const section = options.section ?? current.section;
        if (options.section) rememberSection(options.section);
        return {
          mounted: true,
          open: true,
          section,
          pane: options.section
            ? "section"
            : current.mounted
              ? current.pane
              : "nav",
          // Arriving from the draft overrides where the dialog was left.
          resetKey: options.fromDraft ? current.resetKey + 1 : current.resetKey,
          returnFocus:
            options.trigger ??
            (document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null),
        };
      });
    },
    [settings],
  );

  const selectSection = useCallback((section: SettingsSection): void => {
    rememberSection(section);
    setState((current) =>
      current.section === section
        ? { ...current, pane: "section" }
        : {
            ...current,
            section,
            pane: "section",
            resetKey: current.resetKey + 1,
          },
    );
  }, []);

  const showNav = useCallback((): void => {
    setState((current) => ({ ...current, pane: "nav" }));
  }, []);

  // A default model appearing while the draft waits closes the dialog.
  useEffect(
    () =>
      settings.cache.subscribe(() => {
        const models = selectSettings(
          settings.cache.getSnapshot(),
          "models",
        ).data;
        if (!models) return;
        const active = models.active?.id ?? null;
        const before = lastActive.current;
        lastActive.current = active;
        if (fromDraft.current && before === null && active !== null) close();
      }),
    [settings, close],
  );

  return { state, open, close, selectSection, showNav };
}
