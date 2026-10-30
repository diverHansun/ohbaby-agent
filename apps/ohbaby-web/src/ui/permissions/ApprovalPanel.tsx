import type { UiPermissionChoice, UiPermissionRequest } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Maximize2,
  Minus,
  Square,
  SquareTerminal,
} from "lucide-react";
import { IconButton } from "../shared/IconButton.js";

function permissionButtonClass(choice: UiPermissionChoice): string {
  const base = "ohb-perm-btn";
  if (choice.id === "allow_always") {
    return `${base} ohb-perm-allow-secondary`;
  }
  if (choice.intent === "allow") {
    return `${base} ohb-perm-allow-primary`;
  }
  if (choice.intent === "abort") {
    return `${base} ohb-perm-abort`;
  }
  return `${base} ohb-perm-deny`;
}

const MOD_KEY =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent)
    ? "⌘"
    : "Ctrl";

/**
 * Tool approval floating inside the message area (03 §4.6). Choices come from
 * the backend; several pending requests page with previous/next. The title
 * takes focus rather than the first choice so Enter never approves by accident;
 * from inside the card Esc rejects and ⌘/Ctrl+Enter allows once, like Claude
 * and Codex. A shell command reads as a question over the command itself, with
 * the backend's reason as the subtitle.
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
  readonly onCancel?: () => void;
  readonly canCancel?: boolean;
  readonly cancelLabel?: string;
  readonly permissions: readonly UiPermissionRequest[];
}): ReactElement | null {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const selectedIndex = Math.max(
    0,
    props.permissions.findIndex((request) => request.id === selectedId),
  );
  const request = props.permissions.at(selectedIndex);
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = useRef(new Set<string>());
  const [, update] = useState(0);
  useLayoutEffect(() => {
    for (const id of pending.current)
      if (!props.permissions.some((item) => item.id === id))
        pending.current.delete(id);
    heading.current?.focus({ preventScroll: true });
  }, [request?.id]);
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
  const choices = request.choices.filter(
    (choice) => choice.id !== "cancel" && choice.intent !== "abort",
  );
  const allowOnce = choices.find((choice) => choice.id === "allow_once");
  const reject = choices.find((choice) => choice.intent === "deny");
  const respond = (choice: UiPermissionChoice): void => {
    if (pending.current.has(request.id) || props.disabled) return;
    pending.current.add(request.id);
    update((value) => value + 1);
    const settle = (): void => {
      pending.current.delete(request.id);
      update((value) => value + 1);
    };
    void props.onRespond(request, choice).then((success) => {
      if (!success) settle();
    }, settle);
  };
  const shortcut = (choice: UiPermissionChoice): string | undefined =>
    choice === reject
      ? "Esc"
      : choice === allowOnce
        ? `${MOD_KEY} ↵`
        : undefined;
  return (
    <div className="ohb-approval-layer">
      <section
        className={`ohb-approval-panel${collapsed ? " is-collapsed" : ""}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby="ohb-approval-title"
        onKeyDown={(event) => {
          if (collapsed || event.defaultPrevented) return;
          const choice =
            event.key === "Escape"
              ? reject
              : event.key === "Enter" && (event.metaKey || event.ctrlKey)
                ? allowOnce
                : undefined;
          if (!choice) return;
          event.preventDefault();
          event.stopPropagation();
          respond(choice);
        }}
      >
        <header className="ohb-approval-header">
          <div className="ohb-approval-heading">
            <span className="ohb-approval-source">
              {command ? <SquareTerminal aria-hidden="true" size={13} /> : null}
              Needs approval ·{" "}
              {request.sessionId === request.rootSessionId
                ? "Main agent"
                : (request.sourceLabel ?? request.sessionId)}
            </span>
            <h2 id="ohb-approval-title" ref={heading} tabIndex={-1}>
              {command ? "Run this command?" : request.title}
            </h2>
          </div>
          {multiple ? (
            <nav className="ohb-approval-pager" aria-label="Pending approvals">
              <IconButton
                label="Previous approval"
                disabled={responding || selectedIndex === 0}
                onClick={() => {
                  setSelectedId(props.permissions[selectedIndex - 1].id);
                }}
              >
                <ChevronLeft aria-hidden="true" size={15} />
              </IconButton>
              <span>
                {selectedIndex + 1} of {props.permissions.length}
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
                <ChevronRight aria-hidden="true" size={15} />
              </IconButton>
            </nav>
          ) : null}
          <IconButton
            label={collapsed ? "Expand approval" : "Collapse approval"}
            aria-expanded={!collapsed}
            onClick={() => {
              setCollapsed((value) => !value);
            }}
          >
            {collapsed ? (
              <Maximize2 aria-hidden="true" size={13} />
            ) : (
              <Minus aria-hidden="true" size={15} />
            )}
          </IconButton>
        </header>
        {collapsed ? null : (
          <>
            {command ? (
              <>
                <p className="ohb-approval-reason">{request.title}</p>
                <div className="ohb-approval-body">
                  <pre className="ohb-approval-detail ohb-approval-command">
                    <span aria-hidden="true">$</span>
                    <code>{command}</code>
                  </pre>
                </div>
              </>
            ) : request.description ? (
              <div className="ohb-approval-body">
                <pre className="ohb-approval-detail">{request.description}</pre>
              </div>
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
              {props.onCancel ? (
                <button
                  type="button"
                  className="ohb-approval-stop"
                  aria-label={props.cancelLabel ?? "Stop run"}
                  title={props.cancelLabel ?? "Stop the whole run"}
                  aria-busy={props.cancelLabel !== undefined}
                  disabled={!props.canCancel || props.cancelLabel !== undefined}
                  onClick={props.onCancel}
                >
                  {props.cancelLabel ? (
                    <LoaderCircle
                      aria-hidden="true"
                      className="ohb-stop-pending"
                      size={13}
                    />
                  ) : (
                    <Square aria-hidden="true" size={11} fill="currentColor" />
                  )}
                  <span>Stop</span>
                </button>
              ) : null}
              <span className="ohb-permission-choices">
                {choices.map((choice) => {
                  const keys = shortcut(choice);
                  return (
                    <button
                      className={permissionButtonClass(choice)}
                      disabled={props.disabled || responding}
                      key={`${request.id}:${choice.id}`}
                      onClick={(event) => {
                        if (event.detail > 1) return;
                        respond(choice);
                      }}
                      title={
                        choice.id === "allow_always"
                          ? "Don't ask again for matching requests in this session"
                          : undefined
                      }
                      type="button"
                    >
                      {choice.label}
                      {keys ? (
                        <kbd className="ohb-perm-kbd" aria-hidden="true">
                          {keys}
                        </kbd>
                      ) : null}
                    </button>
                  );
                })}
              </span>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
