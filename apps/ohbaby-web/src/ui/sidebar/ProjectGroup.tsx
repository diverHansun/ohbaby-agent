import { ChevronRight, MoreHorizontal, SquarePen } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { IconButton } from "../shared/IconButton.js";
import { anchorBelow, Menu, type MenuAnchor } from "../shared/Menu.js";
import { workspaceLabel } from "../workspace/workspace-labels.js";

/**
 * A project heading and its sessions. The heading folds the group; a folded
 * group shows how many rows are loaded. Hover reveals New chat in the
 * project and the project menu (Hide project).
 */
export function ProjectGroup(props: {
  readonly directory: string;
  /** The open session belongs to this project. */
  readonly current: boolean;
  readonly available: boolean;
  readonly expanded: boolean;
  readonly loadedCount: number;
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
      className={`ohb-project-group${props.current ? " is-current" : ""}`}
    >
      <div className="ohb-project-heading">
        <button
          type="button"
          className="ohb-project-toggle"
          aria-expanded={props.expanded}
          title={props.available ? props.directory : `${label} is unavailable`}
          onClick={props.onToggle}
        >
          <ChevronRight
            aria-hidden="true"
            size={12}
            className={`ohb-project-chevron${props.expanded ? " is-open" : ""}`}
          />
          <span className="ohb-project-name">{label}</span>
          {!props.expanded && props.loadedCount > 0 ? (
            <span className="ohb-group-count">{props.loadedCount}</span>
          ) : null}
        </button>
        <span className="ohb-project-actions">
          {props.onNewChat ? (
            <IconButton
              label={`New chat in ${label}`}
              onClick={props.onNewChat}
            >
              <SquarePen aria-hidden="true" size={13} />
            </IconButton>
          ) : null}
          <IconButton
            label={`Project actions for ${label}`}
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
        <Menu
          anchor={menu.anchor}
          label={`Actions for ${label}`}
          title={label}
          onClose={(restoreFocus) => {
            if (restoreFocus && menu.trigger.isConnected)
              menu.trigger.focus({ preventScroll: true });
            setMenu(null);
          }}
        >
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setMenu(null);
              props.onHide();
            }}
          >
            <span>Hide project</span>
          </button>
        </Menu>
      ) : null}
    </section>
  );
}
