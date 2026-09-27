import type { UiPermissionChoice, UiPermissionRequest } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useState } from "react";

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
  readonly error?: string;
  readonly syncing: boolean;
  readonly onRetry: () => void;
  readonly onRespond: (
    request: UiPermissionRequest,
    choice: UiPermissionChoice,
  ) => void;
  readonly permissions: readonly UiPermissionRequest[];
}): ReactElement | null {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIndex = Math.max(
    0,
    props.permissions.findIndex((request) => request.id === selectedId),
  );
  if (props.permissions.length === 0) {
    return props.error ? (
      <div className="ohb-permission-sync" role="status">
        {props.error}
        <button onClick={props.onRetry} type="button">
          Retry approvals
        </button>
      </div>
    ) : null;
  }
  const request = props.permissions[selectedIndex];
  return (
    <div className="ohb-permission-layer">
      <section className="ohb-permission-modal" role="dialog" aria-modal="true">
        <div className="ohb-permission-copy">
          <span>
            {request.sessionId === request.rootSessionId
              ? "Main agent"
              : (request.sourceLabel ?? request.sessionId)}
          </span>
          <h2>{request.title}</h2>
          <p>{request.description}</p>
          {props.permissions.length > 1 ? (
            <nav aria-label="Pending approvals">
              <button
                aria-label="Previous approval"
                disabled={selectedIndex === 0}
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
                disabled={selectedIndex === props.permissions.length - 1}
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
                disabled={props.disabled}
                key={choice.id}
                onClick={() => {
                  props.onRespond(request, choice);
                }}
                type="button"
              >
                {choice.label}
              </button>
            ))}
        </div>
      </section>
    </div>
  );
}
