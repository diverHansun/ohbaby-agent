import { Check, ChevronDown, Folder, FolderPlus } from "lucide-react";
import { type ReactElement, useRef, useState } from "react";
import type { SidebarWorkspace } from "../../store/sidebar-groups.js";
import { Menu, type MenuAnchor } from "../shared/Menu.js";
import { workspaceLabel } from "../workspace/workspace-labels.js";

/** Lists longer than this get the menu's filter field (Menu contract). */
const FILTER_THRESHOLD = 8;

/**
 * The draft's workspace choice above the composer card (05 WorkspacePicker):
 * No workspace, the known workspaces, then Open folder…. Changing it never
 * touches the composer text. When the workspace list could not be read, the
 * menu says so and offers Retry.
 */
export function WorkspacePicker(props: {
  readonly value: string | null;
  readonly workspaces: readonly SidebarWorkspace[];
  readonly disabled?: boolean;
  readonly loadFailed?: boolean;
  readonly onChange: (directory: string | null) => void;
  readonly onOpenFolder: () => void;
  readonly onRetry?: () => void;
}): ReactElement {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const label =
    props.value === null ? "No workspace" : workspaceLabel(props.value);
  const available = props.workspaces.filter((workspace) => workspace.available);
  const close = (restoreFocus: boolean): void => {
    setAnchor(null);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };
  const choose = (directory: string | null): void => {
    close(true);
    if (directory !== props.value) props.onChange(directory);
  };
  const item = (
    directory: string | null,
    text: string,
    title?: string,
  ): ReactElement => (
    <button
      key={directory ?? "recents"}
      role="menuitem"
      type="button"
      title={title}
      aria-current={directory === props.value ? "true" : undefined}
      onClick={() => {
        choose(directory);
      }}
    >
      <span>{text}</span>
      {directory === props.value ? (
        <Check aria-hidden="true" size={13} />
      ) : null}
    </button>
  );
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="ohb-workspace-slot ohb-workspace-picker"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={`Workspace: ${label}`}
        title={props.value ?? undefined}
        disabled={props.disabled}
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          setAnchor({
            x: bounds.left,
            y: bounds.bottom + 4,
            aboveY: bounds.top - 4,
            alignRight: false,
          });
        }}
      >
        <Folder aria-hidden="true" size={14} />
        <span>{label}</span>
        <ChevronDown aria-hidden="true" size={13} />
      </button>
      {anchor ? (
        <Menu
          anchor={anchor}
          label="Choose a workspace"
          title="Workspace"
          className="ohb-workspace-picker-menu"
          filterable={available.length > FILTER_THRESHOLD}
          onClose={close}
        >
          {item(null, "No workspace")}
          {available.map((workspace) =>
            item(
              workspace.directory,
              workspaceLabel(workspace.directory),
              workspace.directory,
            ),
          )}
          {props.loadFailed ? (
            <button
              role="menuitem"
              type="button"
              className="ohb-workspace-picker-error"
              onClick={() => {
                close(true);
                props.onRetry?.();
              }}
            >
              <span>Workspaces could not be loaded. Retry</span>
            </button>
          ) : null}
          <div className="ohb-menu-separator" role="separator" />
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              close(false);
              props.onOpenFolder();
            }}
          >
            <FolderPlus aria-hidden="true" size={13} />
            <span>Open folder…</span>
          </button>
        </Menu>
      ) : null}
    </>
  );
}
