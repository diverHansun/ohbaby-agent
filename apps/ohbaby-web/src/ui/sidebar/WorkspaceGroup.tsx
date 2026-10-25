import { Folder, FolderOpen, MoreHorizontal, SquarePen } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { IconButton } from "../shared/IconButton.js";
import { anchorBelow, type MenuAnchor } from "../shared/Menu.js";
import { WorkspaceMenu } from "./WorkspaceMenu.js";
import { workspaceLabel } from "../workspace/workspace-labels.js";

/**
 * A workspace heading and its sessions. The heading folds the group; hover
 * reveals New chat in the workspace and the workspace menu (Hide workspace).
 */
export function WorkspaceGroup(props: {
  readonly directory: string;
  /** The open session belongs to this workspace. */
  readonly current: boolean;
  readonly available: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onNewChat?: () => void;
  readonly onHide: () => void;
  readonly children?: ReactNode;
}): ReactElement {
  const label = workspaceLabel(props.directory);
  const [menu, setMenu] = useState<{
    readonly anchor: MenuAnchor;
    readonly trigger: HTMLButtonElement;
  } | null>(null);
  return (
    <section
      className={`ohb-workspace-group${props.current ? " is-current" : ""}`}
    >
      <div className="ohb-workspace-heading">
        <button
          type="button"
          className="ohb-workspace-toggle"
          aria-expanded={props.expanded}
          title={props.available ? props.directory : `${label} is unavailable`}
          onClick={props.onToggle}
        >
          {/* The folder shows the fold state, like Codex and Cursor. */}
          {props.expanded ? (
            <FolderOpen
              aria-hidden="true"
              size={15}
              className="ohb-workspace-folder"
            />
          ) : (
            <Folder
              aria-hidden="true"
              size={15}
              className="ohb-workspace-folder"
            />
          )}
          <span className="ohb-workspace-name">{label}</span>
        </button>
        <span className="ohb-workspace-actions">
          {props.onNewChat ? (
            <IconButton
              label={`New chat in ${label}`}
              onClick={props.onNewChat}
            >
              <SquarePen aria-hidden="true" size={13} />
            </IconButton>
          ) : null}
          <IconButton
            label={`Workspace actions for ${label}`}
            onClick={(event) => {
              setMenu({
                anchor: anchorBelow(event.currentTarget),
                trigger: event.currentTarget,
              });
            }}
          >
            <MoreHorizontal aria-hidden="true" size={13} />
          </IconButton>
        </span>
      </div>
      {props.expanded ? props.children : null}
      {menu ? (
        <WorkspaceMenu
          anchor={menu.anchor}
          title={label}
          onHide={props.onHide}
          onClose={(restoreFocus) => {
            if (restoreFocus && menu.trigger.isConnected)
              menu.trigger.focus({ preventScroll: true });
            setMenu(null);
          }}
        />
      ) : null}
    </section>
  );
}
