import type { ReactElement } from "react";
import { EyeOff } from "lucide-react";
import { Menu, type MenuAnchor } from "../shared/Menu.js";

/** Project visibility affects the sidebar; the open conversation stays usable. */
export function ProjectMenu(props: {
  readonly anchor: MenuAnchor;
  readonly title: string;
  readonly onClose: (restoreFocus: boolean) => void;
  readonly onHide: () => void;
}): ReactElement {
  return (
    <Menu
      anchor={props.anchor}
      label={`Actions for ${props.title}`}
      title={props.title}
      onClose={props.onClose}
    >
      <button
        role="menuitem"
        type="button"
        onClick={() => {
          props.onClose(true);
          props.onHide();
        }}
      >
        <EyeOff aria-hidden="true" size={13} />
        <span>Hide project</span>
      </button>
    </Menu>
  );
}
