import type { ReactElement } from "react";
import {
  type GoalPanelIntent,
  GoalStatusChip,
} from "../commands/GoalControl.js";
import { ContextUsageControl } from "../shared/ContextUsage.js";
import { compactHomePath, workspaceLabel } from "../workspace/ProjectRail.js";
import { type HeaderModel, type ViewModel } from "./selectors.js";

export function EmptyState(props: {
  readonly onOpenGoalPanel: (intent?: GoalPanelIntent) => void;
  readonly status: HeaderModel;
  readonly view: ViewModel;
  readonly workspaceDirectory: string | null;
}): ReactElement {
  const workspaceDirectory = props.workspaceDirectory ?? "";
  const contextLine = [
    props.view.activeSession?.title ??
      (workspaceDirectory
        ? workspaceLabel(workspaceDirectory)
        : "ohbaby-agent"),
    props.view.activeSession?.projectRoot ??
      (workspaceDirectory
        ? compactHomePath(workspaceDirectory)
        : "workspace ready"),
    props.status.modelLabel,
  ];
  return (
    <>
      <div className="ohb-empty-status">
        <StatusPill
          kind={props.status.connectionKind}
          label={props.status.statusLabel}
        />
        <GoalStatusChip
          goal={props.view.activeGoal}
          onOpen={props.onOpenGoalPanel}
        />
      </div>
      <section className="ohb-empty-hero">
        <div className="ohb-wordmark" aria-label="ohbaby">
          <span>oh</span>
          <span>ba</span>
          <span>by</span>
        </div>
        <div className="ohb-empty-context">
          {contextLine.map((item, index) => (
            <span key={`${item}-${String(index)}`}>{item}</span>
          ))}
        </div>
      </section>
    </>
  );
}

export function StatusBar(props: {
  readonly waitingSummary?: string;
  readonly activeGoal: ViewModel["activeGoal"];
  readonly header: HeaderModel;
  readonly onOpenGoalPanel: (intent?: GoalPanelIntent) => void;
  readonly sessionId: string | null;
}): ReactElement {
  return (
    <header className="ohb-statusbar">
      <div className="ohb-brand ohb-brand-wordmark" aria-label="ohbaby">
        <span>oh</span>
        <span>ba</span>
        <span>by</span>
      </div>
      <div className="ohb-statusbar-meta">
        <StatusPill
          kind={props.header.connectionKind}
          label={
            props.waitingSummary &&
            (props.header.connectionKind === "running" ||
              props.header.connectionKind === "idle")
              ? "Waiting"
              : props.header.statusLabel
          }
          title={props.waitingSummary}
        />
        <span className="ohb-divider" />
        <span className="ohb-model">{props.header.modelLabel}</span>
        <span className="ohb-divider" />
        <ContextUsageControl
          sessionId={props.sessionId}
          usage={props.header.contextWindowUsage}
        />
        <GoalStatusChip
          goal={props.activeGoal}
          onOpen={props.onOpenGoalPanel}
        />
      </div>
    </header>
  );
}

export function StatusPill(props: {
  readonly kind: HeaderModel["connectionKind"];
  readonly label?: string;
  readonly title?: string;
}): ReactElement {
  return (
    <span
      className={`ohb-status-pill ohb-status-${props.kind}`}
      title={props.title}
    >
      {props.label ?? props.kind}
    </span>
  );
}

export function ErrorBanner(props: {
  readonly message: string | null;
  readonly onDismiss: () => void;
}): ReactElement | null {
  if (!props.message) {
    return null;
  }
  return (
    <div className="ohb-error-banner" role="alert">
      <span>{props.message}</span>
      <button onClick={props.onDismiss} type="button">
        Dismiss
      </button>
    </div>
  );
}
