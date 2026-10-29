import { isNarrowViewport } from "../shared/viewport.js";

const STORAGE_KEY = "ohbaby.web.side-panel.v1";
export const SIDE_PANEL_MIN_WIDTH = 320;
export const SIDE_PANEL_MAX_WIDTH = 720;
export const SIDE_PANEL_DEFAULT_WIDTH = 420;

export interface SidePanelPreference {
  readonly open: boolean;
  readonly width: number;
}

export function clampSidePanelWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDE_PANEL_DEFAULT_WIDTH;
  return Math.round(
    Math.min(SIDE_PANEL_MAX_WIDTH, Math.max(SIDE_PANEL_MIN_WIDTH, width)),
  );
}

/**
 * Only whether the panel is open and its width survive a reload (D50). Narrow
 * windows always start closed, because the panel covers the main area there.
 */
export function initialSidePanel(): SidePanelPreference {
  const fallback = { open: false, width: SIDE_PANEL_DEFAULT_WIDTH };
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<SidePanelPreference>;
    return {
      open: !isNarrowViewport() && value.open === true,
      width: clampSidePanelWidth(Number(value.width)),
    };
  } catch {
    return fallback;
  }
}

export function rememberSidePanel(preference: SidePanelPreference): void {
  if (isNarrowViewport()) return;
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Remembering the panel is a convenience only.
  }
}
