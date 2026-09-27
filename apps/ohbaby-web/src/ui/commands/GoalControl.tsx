import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import type { OhbabyWebRuntime } from "../../runtime.js";
import { type ViewModel } from "../session/selectors.js";
import {
  OverlayResult,
  type OverlayStatus,
  OverlayStatusLine,
  runOverlayAction,
} from "./overlay-controls.js";

type GoalPanelAction = "delete" | "pause" | "resume" | "save" | "view";

export interface GoalPanelIntent {
  readonly action: GoalPanelAction;
  readonly objectiveDraft?: string;
}

export const DEFAULT_GOAL_PANEL_INTENT: GoalPanelIntent = { action: "view" };

export function GoalStatusChip(props: {
  readonly goal: ViewModel["activeGoal"];
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
  readonly onExecuteSlashCommand: OhbabyWebRuntime["executeSlashCommand"];
  readonly view: ViewModel;
}): ReactElement {
  const sessionId =
    props.view.composer.activeSessionId ?? props.view.activeSession?.id;
  const activeGoal = props.view.activeGoal;
  const [objective, setObjective] = useState(
    props.intent.objectiveDraft ?? activeGoal?.objective ?? "",
  );
  const [status, setStatus] = useState<OverlayStatus>({
    kind: "idle",
    message: sessionId ? "" : "No active session for goal commands.",
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
          await props.onExecuteSlashCommand({
            allowOverlay: true,
            sessionId,
            text,
          });
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
      activeGoal ? "Saving goal" : "Creating goal",
      activeGoal ? "goal updated" : "goal created",
    );
  }, [activeGoal, objective, runGoalCommand]);

  const pauseGoal = useCallback(() => {
    runGoalCommand("/goal pause", "Pausing goal", "goal paused");
  }, [runGoalCommand]);

  const resumeGoal = useCallback(() => {
    runGoalCommand("/goal resume", "Resuming goal", "goal resumed");
  }, [runGoalCommand]);

  const deleteGoal = useCallback(() => {
    runGoalCommand("/goal cancel", "Deleting goal", "goal deleted");
  }, [runGoalCommand]);
  const canSaveGoal = Boolean(sessionId) && objective.trim().length > 0;

  return (
    <div className="ohb-structured-body">
      {activeGoal ? (
        <OverlayResult
          rows={[
            ["status", activeGoal.status],
            ["objective", activeGoal.objective],
            ...(activeGoal.pauseReason
              ? [["reason", activeGoal.pauseReason] as const]
              : []),
          ]}
        />
      ) : (
        <p>No current goal for this session.</p>
      )}
      <label className="ohb-structured-field ohb-goal-objective-field">
        <span>Objective</span>
        <textarea
          autoFocus={props.intent.action === "save"}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            setObjective(event.target.value);
          }}
          placeholder="Describe the goal"
          rows={4}
          value={objective}
        />
      </label>
      <OverlayStatusLine status={status} />
      <div className="ohb-structured-actions ohb-goal-actions">
        <button
          autoFocus={props.intent.action === "delete"}
          className={goalActionButtonClass(
            props.intent,
            "delete",
            "ohb-button",
          )}
          data-goal-action="delete"
          disabled={!sessionId || !activeGoal}
          onClick={deleteGoal}
          title="Delete goal"
          type="button"
        >
          Delete goal
        </button>
        <button
          autoFocus={props.intent.action === "pause"}
          className={goalActionButtonClass(props.intent, "pause", "ohb-button")}
          data-goal-action="pause"
          disabled={!sessionId || activeGoal?.status !== "active"}
          onClick={pauseGoal}
          title="Pause goal"
          type="button"
        >
          Pause
        </button>
        <button
          autoFocus={props.intent.action === "resume"}
          className={goalActionButtonClass(
            props.intent,
            "resume",
            "ohb-button",
          )}
          data-goal-action="resume"
          disabled={!sessionId || activeGoal?.status !== "paused"}
          onClick={resumeGoal}
          title="Resume goal"
          type="button"
        >
          Resume
        </button>
        <button
          className={goalActionButtonClass(
            props.intent,
            "save",
            "ohb-button-primary",
          )}
          data-goal-action="save"
          disabled={!canSaveGoal}
          onClick={saveGoal}
          title="Save goal"
          type="button"
        >
          Save
        </button>
      </div>
    </div>
  );
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

export function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
