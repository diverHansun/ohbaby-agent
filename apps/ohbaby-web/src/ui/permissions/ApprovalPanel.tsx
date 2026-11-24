import type { UiPermissionChoice, UiPermissionRequest } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minus,
  ShieldQuestion,
  SquareTerminal,
} from "lucide-react";
import { IconButton } from "../shared/IconButton.js";
import { ShellTokens } from "../shared/ShellTokens.js";

const MOD_KEY =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent)
    ? "⌘"
    : "Ctrl";

/**
 * True while the user has words in a field that is still on screen, such as
 * the other chat's input. The composer this card replaces is inert by now.
 */
function isTypingElsewhere(): boolean {
  const active = document.activeElement;
  return (
    (active instanceof HTMLTextAreaElement ||
      active instanceof HTMLInputElement) &&
    active.value.trim() !== "" &&
    active.closest("[inert]") === null
  );
}

function ShellCommand(props: { readonly command: string }): ReactElement {
  return (
    <pre className="ohb-approval-command">
      <code>
        <ShellTokens command={props.command} />
      </code>
    </pre>
  );
}

/**
 * Tool approval in the composer's place (03 §4.6): the composer is hidden with
 * its draft kept, so nothing can be sent while a request waits. The card only
 * answers the request; stopping the run stays with the composer. Choices come
 * from the backend; several pending requests page with previous/next. The
 * title takes focus so Enter never approves by accident; inside the card Esc
 * rejects and ⌘/Ctrl+Enter allows once, like Claude and Codex. Other allow
 * choices (Always allow) open above the primary button.
 */
export function ApprovalPanel(props: {
  readonly disabled: boolean;
  readonly error?: string;
  readonly syncing: boolean;
  readonly onRetry: () => void;
  readonly onRespond: (
    request: UiPermissionRequest,
    choice: UiPermissionChoice,
  ) => Promise<boolean>;
  readonly permissions: readonly UiPermissionRequest[];
}): ReactElement | null {
  const titleId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const selectedIndex = Math.max(
    0,
    props.permissions.findIndex((request) => request.id === selectedId),
  );
  const request = props.permissions.at(selectedIndex);
  const heading = useRef<HTMLHeadingElement>(null);
  const menu = useRef<HTMLSpanElement>(null);
  const pending = useRef(new Set<string>());
  const [, update] = useState(0);
  useLayoutEffect(() => {
    for (const id of pending.current)
      if (!props.permissions.some((item) => item.id === id))
        pending.current.delete(id);
    setMenuOpen(false);
    if (!isTypingElsewhere()) heading.current?.focus({ preventScroll: true });
  }, [request?.id]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent): void => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return (): void => {
      document.removeEventListener("pointerdown", close);
    };
  }, [menuOpen]);
  const responding = request ? pending.current.has(request.id) : false;
  if (!request) {
    return props.error ? (
      <div className="ohb-permission-sync" role="status">
        {props.error}
        <button onClick={props.onRetry} type="button">
          Retry approvals
        </button>
      </div>
    ) : null;
  }
  const multiple = props.permissions.length > 1;
  const { command } = request;
  const allows = request.choices.filter((choice) => choice.intent === "allow");
  const primary =
    allows.find((choice) => choice.id === "allow_once") ?? allows.at(0);
  const extras = allows.filter((choice) => choice !== primary);
  const denies = request.choices.filter((choice) => choice.intent === "deny");
  const reject = denies.at(0);
  const blocked = props.disabled || responding;
  const respond = (choice: UiPermissionChoice): void => {
    if (pending.current.has(request.id) || props.disabled) return;
    pending.current.add(request.id);
    setMenuOpen(false);
    update((value) => value + 1);
    const settle = (): void => {
      pending.current.delete(request.id);
      update((value) => value + 1);
    };
    void props.onRespond(request, choice).then((success) => {
      if (!success) settle();
    }, settle);
  };
  // Only whether a subagent asks; its name and role stay in the subagent view.
  const fromRoot = request.sessionId === request.rootSessionId;
  const source = fromRoot ? "Main agent" : "Sub agent";
  return (
    <div className="ohb-approval-layer">
      <section
        className={`ohb-approval-panel${collapsed ? " is-collapsed" : ""}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        // Clicking the command text must not drop the card's shortcuts.
        tabIndex={-1}
        onKeyDown={(event) => {
          if (collapsed || event.defaultPrevented) return;
          if (menuOpen && event.key === "Escape") {
            event.preventDefault();
            setMenuOpen(false);
            return;
          }
          // Holding a key must not answer the next request as well.
          if (event.repeat) return;
          const choice =
            event.key === "Escape"
              ? reject
              : event.key === "Enter" && (event.metaKey || event.ctrlKey)
                ? primary
                : undefined;
          if (!choice) return;
          event.preventDefault();
          event.stopPropagation();
          respond(choice);
        }}
      >
        <header className="ohb-approval-kicker">
          {command ? (
            <SquareTerminal aria-hidden="true" size={14} />
          ) : (
            <ShieldQuestion aria-hidden="true" size={14} />
          )}
          <span className="ohb-approval-source">
            {command ? "Terminal" : "Permission"} · {source}
          </span>
          {multiple ? (
            <nav className="ohb-approval-pager" aria-label="Pending approvals">
              <IconButton
                label="Previous approval"
                disabled={responding || selectedIndex === 0}
                onClick={() => {
                  setSelectedId(props.permissions[selectedIndex - 1].id);
                }}
              >
                <ChevronLeft aria-hidden="true" size={14} />
              </IconButton>
              <span>
                {selectedIndex + 1} / {props.permissions.length}
              </span>
              <IconButton
                label="Next approval"
                disabled={
                  responding || selectedIndex === props.permissions.length - 1
                }
                onClick={() => {
                  setSelectedId(props.permissions[selectedIndex + 1].id);
                }}
              >
                <ChevronRight aria-hidden="true" size={14} />
              </IconButton>
            </nav>
          ) : null}
          <IconButton
            label={collapsed ? "Expand approval" : "Collapse approval"}
            aria-expanded={!collapsed}
            onClick={() => {
              setMenuOpen(false);
              setCollapsed((value) => !value);
            }}
          >
            {collapsed ? (
              <Maximize2 aria-hidden="true" size={12} />
            ) : (
              <Minus aria-hidden="true" size={14} />
            )}
          </IconButton>
        </header>
        <h2 id={titleId} ref={heading} tabIndex={-1}>
          {command
            ? (request.commandDescription ?? "Run this command?")
            : request.title}
        </h2>
        {collapsed ? null : (
          <>
            {command ? (
              <ShellCommand command={command} />
            ) : request.description ? (
              <pre className="ohb-approval-command ohb-approval-detail">
                {request.description}
              </pre>
            ) : null}
            {props.syncing || props.error ? (
              <div className="ohb-approval-status" role="status">
                {props.syncing ? "Synchronizing approvals…" : props.error}
                {props.error ? (
                  <button onClick={props.onRetry} type="button">
                    Retry approvals
                  </button>
                ) : null}
              </div>
            ) : null}
            <footer className="ohb-permission-actions">
              {denies.map((choice) => (
                <button
                  className="ohb-perm-btn ohb-perm-deny"
                  disabled={blocked}
                  key={`${request.id}:${choice.id}`}
                  onClick={(event) => {
                    if (event.detail > 1) return;
                    respond(choice);
                  }}
                  type="button"
                >
                  {choice.label}
                  {choice === reject ? (
                    <kbd className="ohb-perm-kbd" aria-hidden="true">
                      Esc
                    </kbd>
                  ) : null}
                </button>
              ))}
              {primary ? (
                <span
                  className={`ohb-perm-split${extras.length > 0 ? " has-menu" : ""}`}
                  ref={menu}
                >
                  <button
                    className="ohb-perm-btn ohb-perm-allow"
                    disabled={blocked}
                    key={`${request.id}:${primary.id}`}
                    onClick={(event) => {
                      if (event.detail > 1) return;
                      respond(primary);
                    }}
                    type="button"
                  >
                    {primary.label}
                    <kbd className="ohb-perm-kbd" aria-hidden="true">
                      {MOD_KEY}↵
                    </kbd>
                  </button>
                  {extras.length > 0 ? (
                    <>
                      <button
                        className="ohb-perm-btn ohb-perm-allow ohb-perm-more"
                        disabled={blocked}
                        aria-label="More approval options"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        onClick={() => {
                          setMenuOpen((open) => !open);
                        }}
                        type="button"
                      >
                        <ChevronDown aria-hidden="true" size={13} />
                      </button>
                      {menuOpen ? (
                        <span className="ohb-perm-menu" role="menu">
                          {extras.map((choice) => (
                            <button
                              key={`${request.id}:${choice.id}`}
                              role="menuitem"
                              onClick={() => {
                                respond(choice);
                              }}
                              type="button"
                            >
                              <span>{choice.label}</span>
                              {choice.id === "allow_always" ? (
                                <small>
                                  Don&apos;t ask again for matching requests in{" "}
                                  {fromRoot ? "this session" : "this subagent"}
                                </small>
                              ) : null}
                            </button>
                          ))}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </span>
              ) : null}
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
