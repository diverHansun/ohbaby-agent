import type { ReactElement } from "react";
import { LycheeMark } from "../shared/LycheeMark.js";

/**
 * Placeholder while an existing conversation is read for the first time: the
 * Lychee mark in gray with a light sweep. It fades in after a short delay in
 * CSS, so a fast read shows only blank conversation space.
 */
export function SessionLoading(): ReactElement {
  return (
    <div className="ohb-session-loading" role="status" aria-live="polite">
      <span className="ohb-session-loading-mark" aria-hidden="true">
        <LycheeMark size={48} />
      </span>
      <span className="ohb-visually-hidden">Loading conversation…</span>
    </div>
  );
}
