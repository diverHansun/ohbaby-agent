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
import type { SidebarWorkspace } from "../../store/sidebar-groups.js";
import { workspaceLabel } from "../workspace/workspace-labels.js";
import { Menu, type MenuAnchor } from "../shared/Menu.js";

export type SessionExportFormat = "html" | "jsonl";
export type SessionMenuAnchor = MenuAnchor;

/** Why Archive is unavailable while a chat runs or waits for approval (D3). */
export const ARCHIVE_BUSY_HINT = "Stop the chat before archiving";

/** Session row actions. Export switches the menu to a format list in place. */
export function SessionMenu(props: {
  readonly anchor: SessionMenuAnchor;
  readonly pinned: boolean;
  readonly title: string;
  /** The chat is running or awaiting approval, so it cannot be archived. */
  readonly busy: boolean;
  readonly workspaceDirectory: string | null;
  readonly workspaces: readonly SidebarWorkspace[];
  readonly onMove: (directory: string | null) => void;
  readonly onClose: (restoreFocus: boolean) => void;
  readonly onPin: () => void;
  readonly onArchive: () => void;
  readonly onExport: (format: SessionExportFormat) => void;
}): ReactElement {
  const [level, setLevel] = useState<"main" | "export" | "workspace">("main");
  // Returning from the format list puts focus back on Export… (one level per Escape).
  const [returned, setReturned] = useState<"export" | "workspace" | null>(null);
  const back = (): void => {
    setReturned(level === "workspace" ? "workspace" : "export");
    setLevel("main");
  };
  if (level === "workspace") {
    return (
      <Menu
        anchor={props.anchor}
        label="Move to workspace"
        title="Move to workspace"
        level="workspace"
        className="ohb-session-menu"
        filterable={props.workspaces.length > 8}
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
          <span>Move to workspace</span>
        </button>
        {props.workspaces.map((workspace) => (
          <button
            key={workspace.directory}
            role="menuitem"
            type="button"
            title={workspace.directory}
            disabled={
              !workspace.available ||
              workspace.directory === props.workspaceDirectory
            }
            onClick={() => {
              props.onMove(workspace.directory);
            }}
          >
            {workspace.directory === props.workspaceDirectory ? (
              <Check aria-hidden="true" size={13} />
            ) : null}
            <span>{workspaceLabel(workspace.directory)}</span>
            {workspace.directory === props.workspaceDirectory ? (
              <small>(current)</small>
            ) : !workspace.available ? (
              <small>Unavailable</small>
            ) : null}
          </button>
        ))}
        {props.workspaceDirectory !== null ? (
          <>
            <div className="ohb-menu-separator" role="separator" />
            <button
              role="menuitem"
              type="button"
              data-menu-filter="false"
              onClick={() => {
                props.onMove(null);
              }}
            >
              <FolderMinus aria-hidden="true" size={13} />
              <span>Remove from workspace</span>
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
          className="ohb-pin-icon"
          size={13}
          strokeWidth={1.75}
        />
        <span>{props.pinned ? "Unpin" : "Pin"}</span>
      </button>
      <button
        role="menuitem"
        type="button"
        aria-haspopup="menu"
        data-menu-item="workspace"
        data-menu-shortcut="m"
        onClick={() => {
          setLevel("workspace");
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setLevel("workspace");
          }
        }}
      >
        <FolderInput aria-hidden="true" size={13} />
        <span>Move to workspace…</span>
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
        disabled={props.busy}
        title={props.busy ? ARCHIVE_BUSY_HINT : undefined}
        onClick={props.onArchive}
      >
        <Archive aria-hidden="true" size={13} />
        <span>Archive</span>
        {props.busy ? <small>Running</small> : null}
      </button>
    </Menu>
  );
}
