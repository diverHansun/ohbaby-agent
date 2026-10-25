import type { ReactElement, ReactNode } from "react";
import type { SettingsResource } from "../../store/settings-cache.js";
import { useDelayed } from "../shared/use-delayed.js";

/** Reads answered within this time show no loading line (04 §2.6). */
const LOADING_DELAY_MS = 300;

/** Section title with its one primary action on the right. */
export function SectionHeader(props: {
  readonly title: string;
  readonly action?: ReactNode;
}): ReactElement {
  return (
    <header className="ohb-settings-section-header">
      <h2>{props.title}</h2>
      {props.action ? (
        <div className="ohb-settings-section-actions">{props.action}</div>
      ) : null}
    </header>
  );
}

/**
 * The line under a section header: `Loading…` after 300ms, the failure with
 * Retry, or the empty-state sentence. Cached data stays on screen meanwhile.
 */
export function SectionStatus(props: {
  readonly resource: SettingsResource<unknown> & {
    readonly reload: () => Promise<void>;
  };
  readonly empty?: string;
  /** What failed, when the section reads more than one thing. */
  readonly failure?: string;
}): ReactElement | null {
  const { resource } = props;
  const loading = useDelayed(
    resource.status === "loading" && resource.data === undefined,
    LOADING_DELAY_MS,
  );
  if (resource.status === "error")
    return (
      <p className="ohb-settings-status is-error" role="alert">
        <span>
          {props.failure ?? "Couldn't load these settings."}{" "}
          <span className="ohb-settings-status-detail">{resource.error}</span>
        </span>
        <button
          type="button"
          className="ohb-text-button"
          onClick={() => {
            void resource.reload();
          }}
        >
          Retry
        </button>
      </p>
    );
  if (loading) return <p className="ohb-settings-status">Loading…</p>;
  if (props.empty && resource.data !== undefined)
    return <p className="ohb-settings-status">{props.empty}</p>;
  return null;
}
