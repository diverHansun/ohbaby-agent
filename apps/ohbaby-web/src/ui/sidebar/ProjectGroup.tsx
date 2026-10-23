import { ChevronRight, MoreHorizontal, SquarePen } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { IconButton } from "../shared/IconButton.js";
import { anchorBelow, Menu, type MenuAnchor } from "../shared/Menu.js";
import { workspaceLabel } from "../workspace/workspace-labels.js";

/** A project heading with its sessions. Only the current project lists sessions in this batch. */
export function ProjectGroup(props: {
  readonly directory: string;
  readonly current: boolean;
  readonly available: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpen: () => void;
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
          aria-expanded={props.current ? props.expanded : false}
          disabled={!props.available}
          title={props.available ? props.directory : `${label} is unavailable`}
          onClick={props.current ? props.onToggle : props.onOpen}
        >
          <ChevronRight
            aria-hidden="true"
            size={12}
            className={`ohb-project-chevron${
              props.current && props.expanded ? " is-open" : ""
            }`}
          />
          <span className="ohb-project-name">{label}</span>
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
      {props.current && props.expanded ? props.children : null}
      {menu ? (
        <Menu
          anchor={menu.anchor}
          label={`Actions for ${label}`}
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
