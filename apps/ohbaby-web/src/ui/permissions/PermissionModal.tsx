import type { UiPermissionChoice, UiPermissionRequest } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle, Square } from "lucide-react";

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

export function PermissionModal(props: {
  readonly disabled: boolean;
  readonly visible?: boolean;
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
    if (props.visible !== false)
      heading.current?.focus({ preventScroll: true });
  }, [request?.id, props.visible]);
  const responding = request ? pending.current.has(request.id) : false;
  if (props.visible === false) return null;
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
  return (
    <div className="ohb-permission-layer">
      <section
        className="ohb-permission-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ohb-approval-title"
        onKeyDown={(event) => {
          if (event.key !== "Tab" || event.nativeEvent.isComposing) return;
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          ];
          const first = buttons[0],
            last = buttons.at(-1);
          if (buttons.length === 0) {
            event.preventDefault();
            heading.current?.focus();
          } else if (
            event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === heading.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="ohb-permission-copy">
          <span>
            {request.sessionId === request.rootSessionId
              ? "Main agent"
              : (request.sourceLabel ?? request.sessionId)}
          </span>
          <h2 id="ohb-approval-title" ref={heading} tabIndex={-1}>
            {request.title}
          </h2>
          <p>{request.description}</p>
          {props.permissions.length > 1 ? (
            <nav aria-label="Pending approvals">
              <button
                aria-label="Previous approval"
                disabled={responding || selectedIndex === 0}
                onClick={() => {
                  setSelectedId(props.permissions[selectedIndex - 1].id);
                }}
                type="button"
              >
                Previous
              </button>
              <span>
                {selectedIndex + 1} of {props.permissions.length}
              </span>
              <button
                aria-label="Next approval"
                disabled={
                  responding || selectedIndex === props.permissions.length - 1
                }
                onClick={() => {
                  setSelectedId(props.permissions[selectedIndex + 1].id);
                }}
                type="button"
              >
                Next
              </button>
            </nav>
          ) : null}
        </div>
        <div className="ohb-permission-actions">
          {props.syncing ? (
            <span role="status">Synchronizing approvals…</span>
          ) : null}
          {props.error ? (
            <div role="status">
              {props.error}
              <button onClick={props.onRetry} type="button">
                Retry approvals
              </button>
            </div>
          ) : null}
          {request.choices
            .filter(
              (choice) => choice.id !== "cancel" && choice.intent !== "abort",
            )
            .map((choice) => (
              <button
                className={permissionButtonClass(choice)}
                disabled={props.disabled || responding}
                key={`${request.id}:${choice.id}`}
                onClick={(event) => {
                  if (
                    event.detail > 1 ||
                    pending.current.has(request.id) ||
                    props.disabled
                  )
                    return;
                  pending.current.add(request.id);
                  update((value) => value + 1);
                  void props.onRespond(request, choice).then(
                    (success) => {
                      if (!success) {
                        pending.current.delete(request.id);
                        update((value) => value + 1);
                      }
                    },
                    () => {
                      pending.current.delete(request.id);
                      update((value) => value + 1);
                    },
                  );
                }}
                type="button"
              >
                {choice.label}
              </button>
            ))}
          {props.onCancel ? (
            <button
              type="button"
              className="ohb-stop-button"
              aria-label={props.cancelLabel ?? "Stop run"}
              title={props.cancelLabel ?? "Stop run"}
              aria-busy={props.cancelLabel !== undefined}
              disabled={!props.canCancel || props.cancelLabel !== undefined}
              onClick={props.onCancel}
            >
              {props.cancelLabel ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="ohb-stop-pending"
                  size={14}
                />
              ) : (
                <Square aria-hidden="true" size={14} />
              )}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
