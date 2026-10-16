import { Pencil } from "lucide-react";
import { formatDurationSeconds } from "ohbaby-sdk";
import type { UiCommandCompletion, UiGoal } from "ohbaby-sdk";
import type { ChangeEvent, ReactElement } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  OverlayResult,
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
  readonly errorMessage?: string;
  readonly objectiveDraft?: string;
}

export const DEFAULT_GOAL_PANEL_INTENT: GoalPanelIntent = { action: "view" };

const GOAL_STRIP_STATUS_LABEL: Record<UiGoal["status"], string> = {
  active: "Active goal",
  blocked: "Blocked goal",
  paused: "Paused goal",
};

export function GoalComposerStrip(props: {
  readonly disabled?: boolean;
  readonly goal: UiGoal | null;
  readonly onExecuteSlashCommand?: ExecuteGoalCommand;
  readonly onOpenGoalPanel?: (intent?: GoalPanelIntent) => void;
  readonly scopeKey: string;
  readonly sessionId: string | undefined;
}): ReactElement | null {
  const { goal, onExecuteSlashCommand, onOpenGoalPanel, scopeKey, sessionId } =
    props;
  const [busy, setBusy] = useState(false);
  const scopeGeneration = useRef(0);

  useLayoutEffect(() => {
    // A cleared or edited goal must not inherit the previous action's result.
    scopeGeneration.current += 1;
    setBusy(false);
    return (): void => {
      scopeGeneration.current += 1;
    };
  }, [scopeKey, sessionId, goal?.objective]);

  const runDirectAction = useCallback(
    (commandText: string, fallbackAction: "pause" | "resume") => {
      if (!sessionId || !onExecuteSlashCommand) {
        onOpenGoalPanel?.({ action: fallbackAction });
        return;
      }
      const generation = scopeGeneration.current;
      const targetSessionId = sessionId;
      setBusy(true);
      void onExecuteSlashCommand({
        allowOverlay: true,
        sessionId: targetSessionId,
        text: commandText,
      })
        .then((completion) => {
          if (generation !== scopeGeneration.current) return;
          if (completion.status === "failed") {
            onOpenGoalPanel?.({
              action: fallbackAction,
              errorMessage: completion.error.message,
            });
          }
        })
        .catch((error: unknown) => {
          if (generation !== scopeGeneration.current) return;
          onOpenGoalPanel?.({
            action: fallbackAction,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (generation === scopeGeneration.current) {
            setBusy(false);
          }
        });
    },
    [onExecuteSlashCommand, onOpenGoalPanel, sessionId],
  );

  if (!goal) {
    return null;
  }

  const actionDisabled = Boolean(props.disabled) || !sessionId || busy;
  const durationLabel = formatDurationSeconds(goal.wallClockMs / 1000);
  const turnsProgress =
    goal.turnBudget === undefined
      ? null
      : `${String(goal.turnsUsed)}/${String(goal.turnBudget)}`;
  const metaParts = [turnsProgress, durationLabel].filter(
    (part): part is string => part !== null,
  );
  const fullSummaryTitle = [
    `${GOAL_STRIP_STATUS_LABEL[goal.status]}: ${goal.objective}`,
    `Turns ${turnsProgress ?? String(goal.turnsUsed)} · Active time ${durationLabel}`,
    ...(goal.pauseReason ? [goal.pauseReason] : []),
  ].join(" — ");

  const isActive = goal.status === "active";
  const toggleLabel = isActive ? "Pause goal" : "Resume goal";
  const toggleAction = isActive ? "pause" : "resume";

  return (
    <div
      aria-busy={busy || undefined}
      aria-label="Session goal"
      className={`ohb-goal-strip ohb-goal-strip-${goal.status}`}
      data-goal-status={goal.status}
      role="region"
    >
      <div className="ohb-goal-strip-summary" title={fullSummaryTitle}>
        <GoalTargetIcon />
        <span className="ohb-goal-strip-status">
          {GOAL_STRIP_STATUS_LABEL[goal.status]}
        </span>
        <span className="ohb-goal-strip-objective">{goal.objective}</span>
        <span aria-hidden="true" className="ohb-goal-strip-meta">
          · {metaParts.join(" · ")}
        </span>
      </div>
      <div className="ohb-goal-strip-actions">
        <button
          aria-label={toggleLabel}
          className="ohb-goal-strip-button"
          data-goal-strip-action={toggleAction}
          disabled={actionDisabled}
          onClick={() => {
            if (isActive) {
              runDirectAction("/goal pause", "pause");
              return;
            }
            if (goal.status === "blocked") {
              onOpenGoalPanel?.({ action: "resume" });
              return;
            }
            runDirectAction("/goal resume", "resume");
          }}
          title={toggleLabel}
          type="button"
        >
          {isActive ? <GoalPauseIcon /> : <GoalResumeIcon />}
        </button>
        <button
          aria-label="Edit goal"
          className="ohb-goal-strip-button"
          data-goal-strip-action="edit"
          disabled={actionDisabled}
          onClick={() => {
            onOpenGoalPanel?.({ action: "save" });
          }}
          title="Edit goal"
          type="button"
        >
          <Pencil aria-hidden="true" size={13} />
        </button>
      </div>
    </div>
  );
}

function GoalTargetIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="ohb-goal-strip-icon"
      fill="none"
      height="14"
      viewBox="0 0 16 16"
      width="14"
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" fill="currentColor" r="1.15" />
    </svg>
  );
}

function GoalPauseIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="14"
      viewBox="0 0 16 16"
      width="14"
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M6.6 5.6v4.8M9.4 5.6v4.8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.35"
      />
    </svg>
  );
}

function GoalResumeIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="14"
      viewBox="0 0 16 16"
      width="14"
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.8 5.55 10.6 8l-3.8 2.45V5.55Z" fill="currentColor" />
    </svg>
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
  const [status, setStatus] = useState<OverlayStatus>(() =>
    props.intent.errorMessage
      ? { kind: "error", message: props.intent.errorMessage }
      : {
          kind: "idle",
          message: sessionId
            ? unavailableIntentMessage(props.intent.action, activeGoal)
            : "No active session for goal commands.",
        },
  );

  useEffect(() => {
    setObjective(props.intent.objectiveDraft ?? activeGoal?.objective ?? "");
  }, [activeGoal?.objective, props.intent.objectiveDraft]);

  useEffect(() => {
    if (props.intent.errorMessage) {
      setStatus({ kind: "error", message: props.intent.errorMessage });
    }
  }, [props.intent.errorMessage]);

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
      activeGoal ? `/goal replace\n${trimmed}` : `/goal\n${trimmed}`,
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
            <OverlayResult
              rows={[
                [
                  "Turns",
                  activeGoal.turnBudget === undefined
                    ? String(activeGoal.turnsUsed)
                    : `${String(activeGoal.turnsUsed)}/${String(activeGoal.turnBudget)}`,
                ],
                [
                  "Active time",
                  formatDurationSeconds(activeGoal.wallClockMs / 1000),
                ],
              ]}
            />
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
  const [firstLine = "", ...bodyLines] = rawArgs
    .replace(/\r\n/gu, "\n")
    .split("\n");
  const trimmed = firstLine.trim();
  const body = bodyLines.join("\n");
  if (!trimmed) {
    return body.trim()
      ? { action: "save", objectiveDraft: body.trim() }
      : DEFAULT_GOAL_PANEL_INTENT;
  }
  const [command = ""] = trimmed.split(/\s+/u);
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
        objectiveDraft: [trimmed.slice(command.length).trimStart(), body]
          .join("\n")
          .trim(),
      };
    default:
      return {
        action: "save",
        objectiveDraft: [trimmed, body].join("\n").trim(),
      };
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
