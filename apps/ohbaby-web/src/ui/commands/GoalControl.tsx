import type { UiCommandCompletion, UiGoal } from "ohbaby-sdk";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  type OverlayStatus,
  OverlayStatusLine,
  runOverlayAction,
} from "./overlay-controls.js";

export type ExecuteGoalCommand = (input: {
  readonly allowOverlay: true;
  readonly sessionId: string;
  readonly text: string;
}) => Promise<UiCommandCompletion>;

type GoalPanelAction = "delete" | "pause" | "resume" | "save" | "view";

export interface GoalPanelIntent {
  readonly action: GoalPanelAction;
  readonly objectiveDraft?: string;
}

export const DEFAULT_GOAL_PANEL_INTENT: GoalPanelIntent = { action: "view" };

export function GoalStatusChip(props: {
  readonly goal: UiGoal | null;
  readonly onOpen: (intent?: GoalPanelIntent) => void;
}): ReactElement | null {
  if (!props.goal) {
    return null;
  }
  return (
    <button
      className={`ohb-goal-chip ohb-goal-${props.goal.status}`}
      onClick={() => {
        props.onOpen(DEFAULT_GOAL_PANEL_INTENT);
      }}
      title={props.goal.objective}
      type="button"
    >
      <span />
      goal {props.goal.status}
    </button>
  );
}

export function GoalOverlayBody(props: {
  readonly intent: GoalPanelIntent;
  readonly onExecuteSlashCommand: ExecuteGoalCommand;
  readonly sessionId: string | undefined;
  readonly activeGoal: UiGoal | null;
}): ReactElement {
  const { sessionId, activeGoal } = props;
  const [objective, setObjective] = useState(
    props.intent.objectiveDraft ?? activeGoal?.objective ?? "",
  );
  const [turnLimit, setTurnLimit] = useState("");
  const [durationLimit, setDurationLimit] = useState("");
  const [status, setStatus] = useState<OverlayStatus>({
    kind: "idle",
    message: sessionId
      ? unavailableIntentMessage(props.intent.action, activeGoal)
      : "No active session for goal commands.",
  });

  useEffect(() => {
    setObjective(props.intent.objectiveDraft ?? activeGoal?.objective ?? "");
  }, [activeGoal?.objective, props.intent.objectiveDraft]);

  const runGoalCommand = useCallback(
    (text: string, busyMessage: string, successMessage: string) => {
      if (!sessionId) {
        setStatus({
          kind: "error",
          message: "No active session for goal commands.",
        });
        return;
      }
      void runOverlayAction(
        setStatus,
        async () => {
          const completion = await props.onExecuteSlashCommand({
            allowOverlay: true,
            sessionId,
            text,
          });
          if (completion.status === "failed")
            throw new Error(completion.error.message);
          return successMessage;
        },
        busyMessage,
      );
    },
    [props.onExecuteSlashCommand, sessionId],
  );

  const saveGoal = useCallback(() => {
    const trimmed = objective.trim();
    if (!trimmed) {
      setStatus({ kind: "error", message: "Goal objective is required." });
      return;
    }
    runGoalCommand(
      activeGoal ? `/goal replace ${trimmed}` : `/goal ${trimmed}`,
      activeGoal ? "Saving objective" : "Creating goal",
      activeGoal ? "objective saved" : "goal created",
    );
  }, [activeGoal, objective, runGoalCommand]);

  const pauseGoal = useCallback(() => {
    runGoalCommand("/goal pause", "Pausing goal", "goal paused");
  }, [runGoalCommand]);

  const resumeGoal = useCallback(() => {
    const limits = [
      ...(turnLimit.trim() ? [`${turnLimit.trim()} turns`] : []),
      ...(durationLimit.trim() ? [durationLimit.trim()] : []),
    ];
    runGoalCommand(
      ["/goal resume", ...limits].join(" "),
      "Resuming goal",
      "goal resumed",
    );
  }, [durationLimit, runGoalCommand, turnLimit]);

  const deleteGoal = useCallback(() => {
    runGoalCommand("/goal cancel", "Deleting goal", "goal deleted");
  }, [runGoalCommand]);

  const busy = status.kind === "busy";
  const ready = Boolean(sessionId) && !busy;
  const trimmedObjective = objective.trim();
  const objectiveChanged = activeGoal
    ? trimmedObjective !== activeGoal.objective.trim()
    : true;
  const canSaveGoal = ready && trimmedObjective.length > 0 && objectiveChanged;
  const resumable =
    activeGoal?.status === "paused" || activeGoal?.status === "blocked";

  return (
    <div className="ohb-structured-body ohb-goal-panel" aria-busy={busy}>
      <div className="ohb-goal-state">
        {activeGoal ? (
          <>
            <p className={`ohb-goal-status ohb-goal-${activeGoal.status}`}>
              <span aria-hidden="true" />
              {GOAL_STATUS_LABEL[activeGoal.status]}
            </p>
            {activeGoal.pauseReason ? (
              <p className="ohb-goal-reason">{activeGoal.pauseReason}</p>
            ) : null}
          </>
        ) : (
          <p className="ohb-goal-reason">No goal in this session.</p>
        )}
      </div>
      <div className="ohb-goal-section">
        <label className="ohb-structured-field ohb-goal-objective-field">
          <span>Objective</span>
          <textarea
            autoFocus={props.intent.action === "save"}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
              setObjective(event.target.value);
            }}
            placeholder="Describe the goal"
            rows={3}
            value={objective}
          />
        </label>
        {activeGoal ? (
          <div className="ohb-goal-save-row">
            <small>Replaces the objective; status is unchanged.</small>
            <button
              className={goalActionButtonClass(
                props.intent,
                "save",
                "ohb-button",
              )}
              data-goal-action="save"
              disabled={!canSaveGoal}
              onClick={saveGoal}
              title="Save objective"
              type="button"
            >
              Save objective
            </button>
          </div>
        ) : null}
      </div>
      {resumable ? (
        <details className="ohb-goal-section ohb-goal-optional-limits">
          <summary>Optional limits</summary>
          <p>Totals for this goal. Leave blank to keep the current limit.</p>
          <div className="ohb-goal-limit-grid">
            <label className="ohb-structured-field">
              <span>Turn limit</span>
              <input
                aria-label="Turn limit"
                inputMode="numeric"
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  setTurnLimit(event.target.value);
                }}
                placeholder="e.g. 100"
                type="text"
                value={turnLimit}
              />
            </label>
            <label className="ohb-structured-field">
              <span>Active duration limit</span>
              <input
                aria-label="Active duration limit"
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  setDurationLimit(event.target.value);
                }}
                placeholder="e.g. 3h"
                type="text"
                value={durationLimit}
              />
            </label>
          </div>
        </details>
      ) : null}
      <div aria-live="polite" className="ohb-goal-feedback">
        <OverlayStatusLine status={status} />
      </div>
      <div className="ohb-structured-actions ohb-goal-actions">
        {activeGoal ? (
          <button
            autoFocus={props.intent.action === "delete"}
            className={goalActionButtonClass(
              props.intent,
              "delete",
              "ohb-goal-delete",
            )}
            data-goal-action="delete"
            disabled={!ready}
            onClick={deleteGoal}
            title="Delete goal"
            type="button"
          >
            Delete goal
          </button>
        ) : null}
        {activeGoal?.status === "active" ? (
          <button
            autoFocus={props.intent.action === "pause"}
            className={goalActionButtonClass(
              props.intent,
              "pause",
              "ohb-button",
            )}
            data-goal-action="pause"
            disabled={!ready}
            onClick={pauseGoal}
            title="Pause goal"
            type="button"
          >
            Pause
          </button>
        ) : null}
        {resumable ? (
          <button
            autoFocus={props.intent.action === "resume"}
            className={goalActionButtonClass(
              props.intent,
              "resume",
              "ohb-button-primary",
            )}
            data-goal-action="resume"
            disabled={!ready}
            onClick={resumeGoal}
            title="Resume goal"
            type="button"
          >
            Resume
          </button>
        ) : null}
        {activeGoal ? null : (
          <button
            className="ohb-button-primary"
            data-goal-action="save"
            disabled={!canSaveGoal}
            onClick={saveGoal}
            title="Create goal"
            type="button"
          >
            Create goal
          </button>
        )}
      </div>
    </div>
  );
}

const GOAL_STATUS_LABEL: Record<UiGoal["status"], string> = {
  active: "Active",
  blocked: "Blocked",
  paused: "Paused",
};

function unavailableIntentMessage(
  action: GoalPanelAction,
  goal: UiGoal | null,
): string {
  if (action === "pause" && goal?.status !== "active")
    return goal ? `Only an active goal can be paused.` : "No goal to pause.";
  if (
    action === "resume" &&
    goal?.status !== "paused" &&
    goal?.status !== "blocked"
  )
    return goal ? "Goal is already active." : "No goal to resume.";
  if (action === "delete" && !goal) return "No goal to delete.";
  return "";
}

export function goalPanelIntentFromArgs(rawArgs: string): GoalPanelIntent {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return DEFAULT_GOAL_PANEL_INTENT;
  }
  const [command = "", ...rest] = trimmed.split(/\s+/u);
  switch (command) {
    case "status":
      return DEFAULT_GOAL_PANEL_INTENT;
    case "pause":
      return { action: "pause" };
    case "resume":
      return { action: "resume" };
    case "cancel":
      return { action: "delete" };
    case "replace":
      return {
        action: "save",
        objectiveDraft: rest.join(" "),
      };
    default:
      return { action: "save", objectiveDraft: trimmed };
  }
}

function goalActionButtonClass(
  intent: GoalPanelIntent,
  action: GoalPanelAction,
  baseClass: string,
): string {
  return intent.action === action
    ? `${baseClass} ohb-goal-action-highlight`
    : baseClass;
}
