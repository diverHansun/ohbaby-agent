import { Archive, SquarePen } from "lucide-react";
import type { UiSessionIndexEntry } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useMemo } from "react";
import type { WorkspaceSnapshot } from "../../api/daemon/wire.js";
import { compactHomePath, workspaceLabel } from "../workspace/ProjectRail.js";
import { type ViewModel } from "./selectors.js";

export function SessionSidebar(props: {
  readonly open: boolean;
  readonly onArchiveSession: (sessionId: string) => void;
  readonly onCreateSession: () => void;
  readonly onSelectSession: (sessionId: string) => void;
  readonly view: ViewModel;
  readonly workspace: WorkspaceSnapshot;
}): ReactElement {
  const sessions = useMemo(
    () => sortedSessions(props.view.sessionIndex),
    [props.view.sessionIndex],
  );
  const activeSessionId = props.view.activeSession?.id;

  return (
    <aside
      aria-hidden={!props.open}
      className={`ohb-sidebar${props.open ? "" : " is-collapsed"}`}
      inert={!props.open}
    >
      <header className="ohb-sidebar-header">
        <div className="ohb-project-header">
          <strong>
            {workspaceLabel(props.workspace.selectedDirectory ?? "")}
          </strong>
          <small title={props.workspace.selectedDirectory ?? ""}>
            {compactHomePath(props.workspace.selectedDirectory ?? "")}
          </small>
        </div>
      </header>
      <button
        className="ohb-sidebar-new"
        disabled={props.view.composer.disabled}
        onClick={props.onCreateSession}
        title="New session"
        type="button"
      >
        <SquarePen aria-hidden="true" size={15} />
        <span>New session</span>
      </button>
      <section className="ohb-sidebar-section">
        <div className="ohb-sidebar-section-title">Recent sessions</div>
        <div className="ohb-sidebar-list">
          {sessions.length > 0 ? (
            sessions.map((session) => {
              const active = session.id === activeSessionId;
              const running = active && props.view.composer.isRunning;
              const title = sessionTitle(session);
              const disabled = props.view.composer.disabled;
              return (
                <div
                  className={`ohb-session-row ${
                    active ? "ohb-session-active" : ""
                  } ${running ? "ohb-session-running" : ""} ${
                    disabled ? "ohb-session-disabled" : ""
                  }`}
                  aria-current={active ? "page" : undefined}
                  key={session.id}
                >
                  <button
                    className="ohb-session-main"
                    disabled={disabled}
                    onClick={() => {
                      if (!active) {
                        props.onSelectSession(session.id);
                      }
                    }}
                    title={`Select ${title}`}
                    type="button"
                  >
                    <span className="ohb-session-dot" />
                    <span className="ohb-session-copy">
                      <strong>{title}</strong>
                      <small>{sessionMeta(session)}</small>
                    </span>
                  </button>
                  <button
                    aria-label={`Archive ${title}`}
                    className="ohb-session-archive"
                    disabled={disabled}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onArchiveSession(session.id);
                    }}
                    title={`Archive ${title}`}
                    type="button"
                  >
                    <Archive size={14} />
                  </button>
                </div>
              );
            })
          ) : (
            <div className="ohb-sidebar-empty">No sessions yet</div>
          )}
        </div>
      </section>
      <footer className="ohb-sidebar-footer">
        <span>{String(sessions.length)} sessions</span>
      </footer>
    </aside>
  );
}

function sortedSessions(
  sessions: readonly UiSessionIndexEntry[],
): readonly UiSessionIndexEntry[] {
  return [...sessions].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.id.localeCompare(right.id),
  );
}

function sessionTitle(session: UiSessionIndexEntry): string {
  const trimmed = session.title.trim();
  return trimmed.length > 0 ? trimmed : "Untitled session";
}

function sessionMeta(session: UiSessionIndexEntry): string {
  const date = new Date(session.updatedAt);
  return Number.isNaN(date.getTime())
    ? "recent"
    : new Intl.DateTimeFormat("en-US", {
        day: "2-digit",
        month: "short",
      }).format(date);
}
