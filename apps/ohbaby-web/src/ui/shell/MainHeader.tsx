import { PanelLeft } from "lucide-react";
import type { ReactElement } from "react";
import {
  type HeaderModel,
  isConnectionAbnormal,
} from "../session/selectors.js";
import { ContextUsageControl } from "../shared/ContextUsage.js";
import { IconButton } from "../shared/IconButton.js";
import { compactHomePath } from "../workspace/workspace-labels.js";

const CONNECTION_LABELS: Partial<
  Record<HeaderModel["connectionKind"], string>
> = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  resyncing: "Syncing…",
  disconnected: "Offline",
};

/**
 * Top bar of the main area: sidebar toggle when the sidebar is closed,
 * the chat title, its working directory and context usage. Connection state is
 * shown only when a folder's instance exists and is not healthy (D6); with no
 * folder open there is nothing to connect to, so nothing is shown.
 */
export function MainHeader(props: {
  readonly sidebarOpen: boolean;
  readonly onOpenSidebar: () => void;
  readonly title?: string;
  readonly workingDirectory?: string;
  readonly header: HeaderModel;
  readonly hasClient: boolean;
  readonly sessionId: string | null;
  readonly onOpenContextUsage?: () => void;
}): ReactElement {
  const abnormal =
    props.hasClient && isConnectionAbnormal(props.header.connectionKind);
  return (
    <header className="ohb-main-header">
      {props.sidebarOpen ? null : (
        <IconButton label="Open sidebar" onClick={props.onOpenSidebar}>
          <PanelLeft aria-hidden="true" size={15} />
        </IconButton>
      )}
      {props.title ? (
        <div className="ohb-main-header-title">
          <span className="ohb-main-header-name">{props.title}</span>
          {props.workingDirectory ? (
            <span
              className="ohb-main-header-path"
              title={props.workingDirectory}
            >
              {compactHomePath(props.workingDirectory)}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="ohb-main-header-title" />
      )}
      <div className="ohb-main-header-meta">
        {abnormal ? (
          <span
            className={`ohb-connection-state ohb-connection-${props.header.connectionKind}`}
            role="status"
          >
            <span className="ohb-connection-dot" aria-hidden="true" />
            {CONNECTION_LABELS[props.header.connectionKind]}
          </span>
        ) : null}
        {props.sessionId ? (
          <ContextUsageControl
            onOpen={props.onOpenContextUsage}
            sessionId={props.sessionId}
            usage={props.header.contextWindowUsage}
          />
        ) : null}
      </div>
    </header>
  );
}
