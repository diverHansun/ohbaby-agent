import {
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from "lucide-react";
import type { CSSProperties, ReactElement } from "react";
import { useEffect, useState } from "react";
import type { WorkspaceSnapshot } from "../../api/daemon/wire.js";

export function ProjectRail(props: {
  readonly onAdd: () => void;
  readonly onHide: (directory: string) => void;
  readonly onSelect: (directory: string) => void;
  readonly onToggleSessions?: () => void;
  readonly sessionsOpen?: boolean;
  readonly workspace: WorkspaceSnapshot;
}): ReactElement {
  const [menu, setMenu] = useState<{
    readonly directory: string;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  useEffect((): (() => void) | undefined => {
    if (!menu) return;
    const close = (): void => {
      setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  return (
    <nav className="ohb-project-rail" aria-label="Projects">
      {props.workspace.selectedDirectory && props.onToggleSessions ? (
        <button
          aria-expanded={props.sessionsOpen ?? false}
          aria-label={
            props.sessionsOpen ? "Collapse sessions" : "Expand sessions"
          }
          className="ohb-project-rail-toggle"
          onClick={props.onToggleSessions}
          title={props.sessionsOpen ? "Collapse sessions" : "Expand sessions"}
          type="button"
        >
          {props.sessionsOpen ? (
            <PanelLeftClose size={17} />
          ) : (
            <PanelLeftOpen size={17} />
          )}
        </button>
      ) : null}
      <div className="ohb-project-rail-list">
        {props.workspace.scopes.map((scope) => {
          const active = scope.directory === props.workspace.selectedDirectory;
          const label = workspaceLabel(scope.directory);
          return (
            <div className="ohb-project-rail-item" key={scope.directory}>
              <button
                aria-current={active ? "page" : undefined}
                aria-label={`Open ${label}`}
                className={`ohb-project-glyph ${active ? "is-active" : ""} ${
                  scope.available ? "" : "is-unavailable"
                }`}
                disabled={!scope.available}
                onClick={() => {
                  props.onSelect(scope.directory);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({
                    directory: scope.directory,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
                style={
                  {
                    "--project-color": projectColor(scope.directory),
                  } as CSSProperties
                }
                title={
                  scope.available
                    ? `${label}\n${scope.directory}`
                    : `${label} is unavailable`
                }
                type="button"
              >
                {projectInitial(label)}
              </button>
              {active ? (
                <button
                  aria-label={`Project actions for ${label}`}
                  className="ohb-project-actions"
                  onClick={(event) => {
                    event.stopPropagation();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setMenu({
                      directory: scope.directory,
                      x: bounds.right + 6,
                      y: bounds.top,
                    });
                  }}
                  type="button"
                >
                  <MoreHorizontal size={13} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <button
        aria-label="Open project"
        className="ohb-project-add"
        onClick={props.onAdd}
        title="Open project"
        type="button"
      >
        <Plus size={20} />
      </button>
      {menu ? (
        <div
          className="ohb-project-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            onClick={() => {
              props.onHide(menu.directory);
              setMenu(null);
            }}
            role="menuitem"
            type="button"
          >
            Remove from project rail
          </button>
        </div>
      ) : null}
    </nav>
  );
}

function projectInitial(label: string): string {
  return Array.from(label.trim())[0]?.toLocaleUpperCase() ?? "?";
}

function projectColor(directory: string): string {
  let hash = 0;
  for (const character of directory) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined) {
      hash = (hash * 31 + codePoint) >>> 0;
    }
  }
  return `hsl(${String(hash % 360)} 58% 84%)`;
}

export function workspaceLabel(directory: string): string {
  const segments = directory.split(/[\\/]/u).filter(Boolean);
  return segments.at(-1) ?? directory;
}

export function compactHomePath(directory: string): string {
  const home = "/Users/";
  if (directory.startsWith(home)) {
    const parts = directory.slice(home.length).split("/");
    return parts.length > 1 ? `~/${parts.slice(1).join("/")}` : "~";
  }
  return directory;
}
