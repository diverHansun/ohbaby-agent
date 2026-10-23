import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Download,
  Pin,
} from "lucide-react";
import { type ReactElement, useState } from "react";
import { Menu, type MenuAnchor } from "../shared/Menu.js";

export type SessionExportFormat = "html" | "jsonl";
export type SessionMenuAnchor = MenuAnchor;

/** Session row actions. Export switches the menu to a format list in place. */
export function SessionActionsMenu(props: {
  readonly anchor: SessionMenuAnchor;
  readonly pinned: boolean;
  readonly title: string;
  readonly onClose: (restoreFocus: boolean) => void;
  readonly onPin: () => void;
  readonly onArchive: () => void;
  readonly onExport: (format: SessionExportFormat) => void;
}): ReactElement {
  const [level, setLevel] = useState<"main" | "export">("main");
  // Returning from the format list puts focus back on Export… (one level per Escape).
  const [returned, setReturned] = useState(false);
  const back = (): void => {
    setReturned(true);
    setLevel("main");
  };
  if (level === "export") {
    return (
      <Menu
        anchor={props.anchor}
        label="Export format"
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
      level="main"
      className="ohb-session-menu"
      {...(returned ? { focusSelector: "[data-menu-item='export']" } : {})}
      onClose={props.onClose}
    >
      <button role="menuitem" type="button" onClick={props.onPin}>
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
        data-menu-item="export"
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
      <button role="menuitem" type="button" onClick={props.onArchive}>
        <Archive aria-hidden="true" size={13} />
        <span>Archive</span>
      </button>
    </Menu>
  );
}
