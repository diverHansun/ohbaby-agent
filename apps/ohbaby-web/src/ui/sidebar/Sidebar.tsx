import { FolderPlus, PanelLeft, SquarePen } from "lucide-react";
import { type ReactElement, useCallback, useRef, useState } from "react";
import type { WorkspaceSnapshot } from "../../api/daemon/wire.js";
import type { ViewModel } from "../session/selectors.js";
import { IconButton } from "../shared/IconButton.js";
import { Wordmark } from "../shared/Wordmark.js";
import {
  readCollapsedProjects,
  writeCollapsedProjects,
} from "./collapsed-projects.js";
import { ProjectGroup } from "./ProjectGroup.js";
import { sessionPinsKey } from "./session-pins.js";
import type { SessionExportFormat } from "./SessionActionsMenu.js";
import { SessionList } from "./SessionList.js";

export interface SidebarProps {
  readonly serverUrl?: string;
  readonly view: ViewModel;
  readonly workspace: WorkspaceSnapshot;
  readonly onCollapse: () => void;
  readonly onCreateSession: () => void;
  readonly onSelectSession: (sessionId: string) => void;
  readonly onArchiveSession: (sessionId: string) => Promise<boolean>;
  readonly onExportSession: (
    sessionId: string,
    format: SessionExportFormat,
  ) => void;
  readonly onSwitchProject: (directory: string) => void;
  readonly onHideProject: (directory: string) => void;
  readonly onOpenFolder: () => void;
}

/**
 * Wordmark, New chat and the project groups. In this batch only the current
 * project lists its sessions; opening another project switches to it.
 */
export function Sidebar(props: SidebarProps): ReactElement {
  const newRef = useRef<HTMLButtonElement>(null);
  const [collapsed, setCollapsed] = useState(readCollapsedProjects);
  const toggleProject = useCallback((directory: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(directory)) next.delete(directory);
      else next.add(directory);
      writeCollapsedProjects(next);
      return next;
    });
  }, []);
  const selected = props.workspace.selectedDirectory;
  const sessionsDisabled = props.view.composer.disabled;
  return (
    <aside className="ohb-sidebar" aria-label="Chats">
      <div className="ohb-sidebar-top">
        <Wordmark size="sm" />
        <IconButton label="Collapse sidebar" onClick={props.onCollapse}>
          <PanelLeft aria-hidden="true" size={15} />
        </IconButton>
      </div>
      <nav className="ohb-sidebar-nav">
        <button
          ref={newRef}
          type="button"
          className="ohb-sidebar-nav-item ohb-sidebar-new"
          disabled={selected === null || sessionsDisabled}
          onClick={props.onCreateSession}
        >
          <SquarePen aria-hidden="true" size={15} />
          <span>New chat</span>
        </button>
      </nav>
      <div className="ohb-sidebar-scroll">
        <div className="ohb-sidebar-section-title">
          <span>Projects</span>
          <IconButton label="Open folder…" onClick={props.onOpenFolder}>
            <FolderPlus aria-hidden="true" size={13} />
          </IconButton>
        </div>
        {props.workspace.scopes.map((scope) => {
          const current = scope.directory === selected;
          return (
            <ProjectGroup
              key={scope.directory}
              directory={scope.directory}
              current={current}
              available={scope.available}
              expanded={!collapsed.has(scope.directory)}
              onToggle={() => {
                toggleProject(scope.directory);
              }}
              onOpen={() => {
                props.onSwitchProject(scope.directory);
              }}
              {...(current && !sessionsDisabled
                ? { onNewChat: props.onCreateSession }
                : {})}
              onHide={() => {
                props.onHideProject(scope.directory);
              }}
            >
              <SessionList
                key={sessionPinsKey(props.serverUrl, scope.directory)}
                scopeKey={sessionPinsKey(props.serverUrl, scope.directory)}
                view={props.view}
                fallbackFocus={() => newRef.current}
                onSelectSession={props.onSelectSession}
                onArchiveSession={props.onArchiveSession}
                onExportSession={props.onExportSession}
              />
            </ProjectGroup>
          );
        })}
      </div>
    </aside>
  );
}
