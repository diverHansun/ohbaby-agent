import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderInput,
  FolderMinus,
  Check,
  Pin,
} from "lucide-react";
import { type ReactElement, useState } from "react";
import type { SidebarProject } from "../../store/sidebar-groups.js";
import { workspaceLabel } from "../workspace/workspace-labels.js";
import { Menu, type MenuAnchor } from "../shared/Menu.js";

export type SessionExportFormat = "html" | "jsonl";
export type SessionMenuAnchor = MenuAnchor;

/** Session row actions. Export switches the menu to a format list in place. */
export function SessionMenu(props: {
  readonly anchor: SessionMenuAnchor;
  readonly pinned: boolean;
  readonly title: string;
  readonly projectDirectory: string | null;
  readonly projects: readonly SidebarProject[];
  readonly onMove: (directory: string | null) => void;
  readonly onClose: (restoreFocus: boolean) => void;
  readonly onPin: () => void;
  readonly onArchive: () => void;
  readonly onExport: (format: SessionExportFormat) => void;
}): ReactElement {
  const [level, setLevel] = useState<"main" | "export" | "project">("main");
  // Returning from the format list puts focus back on Export… (one level per Escape).
  const [returned, setReturned] = useState<"export" | "project" | null>(null);
  const back = (): void => {
    setReturned(level === "project" ? "project" : "export");
    setLevel("main");
  };
  if (level === "project") {
    return (
      <Menu
        anchor={props.anchor}
        label="Move to project"
        title="Move to project"
        level="project"
        className="ohb-session-menu"
        filterable={props.projects.length > 8}
        onClose={props.onClose}
        onEscape={back}
      >
        <button
          role="menuitem"
          type="button"
          className="ohb-menu-back"
          data-menu-filter="false"
          onClick={back}
        >
          <ChevronLeft aria-hidden="true" size={13} />
          <span>Move to project</span>
        </button>
        {props.projects.map((project) => (
          <button
            key={project.directory}
            role="menuitem"
            type="button"
            title={project.directory}
            disabled={
              !project.available || project.directory === props.projectDirectory
            }
            onClick={() => { props.onMove(project.directory); }}
          >
            {project.directory === props.projectDirectory ? (
              <Check aria-hidden="true" size={13} />
            ) : null}
            <span>{workspaceLabel(project.directory)}</span>
            {project.directory === props.projectDirectory ? (
              <small>(current)</small>
            ) : !project.available ? (
              <small>Unavailable</small>
            ) : null}
          </button>
        ))}
        {props.projectDirectory !== null ? (
          <>
            <div className="ohb-menu-separator" role="separator" />
            <button
              role="menuitem"
              type="button"
              data-menu-filter="false"
              onClick={() => { props.onMove(null); }}
            >
              <FolderMinus aria-hidden="true" size={13} />
              <span>Remove from project</span>
            </button>
          </>
        ) : null}
      </Menu>
    );
  }
  if (level === "export") {
    return (
      <Menu
        anchor={props.anchor}
        label="Export format"
        title={`Export ${props.title}`}
        level="export"
        className="ohb-session-menu"
        onClose={props.onClose}
        onEscape={back}
      >
        <button
          role="menuitem"
          type="button"
          className="ohb-menu-back"
          onClick={back}
        >
          <ChevronLeft aria-hidden="true" size={13} />
          <span>Export</span>
        </button>
        <button
          role="menuitem"
          type="button"
          onClick={() => {
            props.onExport("html");
          }}
        >
          <span>HTML</span>
        </button>
        <button
          role="menuitem"
          type="button"
          onClick={() => {
            props.onExport("jsonl");
          }}
        >
          <span>JSONL</span>
        </button>
      </Menu>
    );
  }
  return (
    <Menu
      anchor={props.anchor}
      label={`Actions for ${props.title}`}
      title={props.title}
      level="main"
      className="ohb-session-menu"
      {...(returned ? { focusSelector: `[data-menu-item='${returned}']` } : {})}
      onClose={props.onClose}
    >
      <button
        role="menuitem"
        type="button"
        data-menu-shortcut="p"
        onClick={props.onPin}
      >
        <Pin
          aria-hidden="true"
          size={13}
          fill={props.pinned ? "currentColor" : "none"}
        />
        <span>{props.pinned ? "Unpin" : "Pin"}</span>
      </button>
      <button
        role="menuitem"
        type="button"
        aria-haspopup="menu"
        data-menu-item="project"
        data-menu-shortcut="m"
        onClick={() => { setLevel("project"); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setLevel("project");
          }
        }}
      >
        <FolderInput aria-hidden="true" size={13} />
        <span>Move to project…</span>
        <ChevronRight aria-hidden="true" className="ohb-menu-arrow" size={13} />
      </button>
      <button
        role="menuitem"
        type="button"
        aria-haspopup="menu"
        data-menu-item="export"
        data-menu-shortcut="e"
        onClick={() => {
          setLevel("export");
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setLevel("export");
          }
        }}
      >
        <Download aria-hidden="true" size={13} />
        <span>Export…</span>
        <ChevronRight aria-hidden="true" className="ohb-menu-arrow" size={13} />
      </button>
      <div className="ohb-menu-separator" role="separator" />
      <button
        role="menuitem"
        type="button"
        data-menu-shortcut="a"
        onClick={props.onArchive}
      >
        <Archive aria-hidden="true" size={13} />
        <span>Archive</span>
      </button>
    </Menu>
  );
}
