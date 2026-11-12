import { ChevronRight, CircleAlert } from "lucide-react";
import type {
  UiMessage,
  UiModelActivity,
  UiPromptError,
  UiRun,
} from "ohbaby-sdk";
import { type ReactElement, useState } from "react";
import type { ReasoningViewState } from "../../api/daemon/wire.js";
import type { TurnTiming } from "./run-process.js";
import { useExecutionDuration } from "./use-execution-duration.js";

/**
 * The model step's wait, one row for its whole request chain: Thinking while
 * a request is out, `Retrying #n` once the service has scheduled a retry. It
 * steps aside when the current step shows something the reader can see.
 */
export function ModelWaiting({
  run,
  messages,
  reasoningByMessageId,
}: {
  readonly run: UiRun | undefined;
  readonly messages: readonly UiMessage[];
  readonly reasoningByMessageId: Readonly<
    Partial<Record<string, ReasoningViewState>>
  >;
}): ReactElement | null {
  const activity = run?.modelActivity;
  const waiting =
    run !== undefined &&
    activity !== undefined &&
    isWaiting(run, activity) &&
    !hasVisibleProgress(
      messages.find((message) => message.id === activity.messageId),
      reasoningByMessageId[activity.messageId],
    );
  const retry = waiting ? retryNumber(activity) : undefined;
  // One clock per request chain; a retry does not start it over. Only
  // Thinking shows it, so retries do not tick every second.
  const startedAt = activity?.waitingStartedAt ?? activity?.startedAt;
  const duration = useExecutionDuration(
    `${activity?.messageId ?? "model"}:${String(startedAt)}`,
    waiting && retry === undefined ? startedAt : undefined,
  );
  if (!waiting) return null;
  const label = retry === undefined ? "Thinking" : `Retrying #${String(retry)}`;
  // Screen readers hear the label when it changes, never the ticking timer.
  return (
    <div className="ohb-thinking" role="status" aria-label={label}>
      <span aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {retry === undefined ? (
        <>
          <span aria-hidden="true">Thinking</span>
          {duration === undefined ? null : (
            <span aria-hidden="true">{duration}</span>
          )}
        </>
      ) : (
        <span aria-hidden="true">
          Retrying #<FlipNumber value={retry} />
        </span>
      )}
      <span className="ohb-visually-hidden">{label}</span>
    </div>
  );
}

function isWaiting(run: UiRun, activity: UiModelActivity): boolean {
  if (
    run.status.kind !== "running" ||
    activity.purpose !== "agent-step" ||
    activity.runId !== run.id
  )
    return false;
  // Servers without `phase` only know the open request.
  if (activity.phase === undefined)
    return activity.outcome === "running" && activity.endedAt === undefined;
  return true;
}

/**
 * Which retry this is: a failed attempt with a retry scheduled points at the
 * next one; a request running inside a retried chain is that retry.
 */
function retryNumber(
  activity: UiModelActivity | undefined,
): number | undefined {
  if (activity?.phase !== "retrying") return undefined;
  const retry =
    activity.outcome === "running" ? activity.attempt - 1 : activity.attempt;
  return retry >= 1 ? retry : undefined;
}

/**
 * Whether the step's message already shows the reader something: text,
 * thinking or a tool card. Notes the app adds and hidden tool calls do not
 * count, so the wait never vanishes into a blank page.
 */
function hasVisibleProgress(
  message: UiMessage | undefined,
  reasoning: ReasoningViewState | undefined,
): boolean {
  if (reasoning?.content.trim()) return true;
  return (
    message?.parts.some((part) => {
      if (
        part.metadata?.kind === "lifecycle-interruption" ||
        part.metadata?.kind === "context-compaction"
      )
        return false;
      if (part.type === "text" || part.type === "reasoning")
        return part.text.trim().length > 0;
      return part.type === "tool-call";
    }) === true
  );
}

/** A number that rolls up to its new value, like a page turning. */
function FlipNumber({ value }: { readonly value: number }): ReactElement {
  const [shown, setShown] = useState({ value, previous: value });
  if (shown.value !== value) setShown({ value, previous: shown.value });
  const rolling = shown.previous !== shown.value;
  return (
    <span className="ohb-flip">
      <span key={shown.value} className={rolling ? "ohb-flip-roll" : undefined}>
        {rolling ? <span>{shown.previous}</span> : null}
        <span>{shown.value}</span>
      </span>
    </span>
  );
}

/** Same three dots as Thinking, squeezed together vertically while history compacts. */
export function Compacting(): ReactElement {
  return (
    <div
      className="ohb-thinking ohb-compacting"
      role="status"
      aria-label="Compacting"
    >
      <span aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>Compacting</span>
    </div>
  );
}

/**
 * A turn's end line: total time and, unless it succeeded, how it ended. The
 * name predates turns by run; it now serves any turn, with or without a prompt
 * (turn-projection 00 P12). `label` names what started a non-user turn.
 */
export function PromptDuration({
  timing,
  label: origin,
  disclosure,
}: {
  readonly timing: TurnTiming;
  readonly label?: string;
  readonly disclosure?: {
    readonly open: boolean;
    readonly controls: string;
    readonly id: string;
    readonly onToggle: () => void;
  };
}): ReactElement {
  const duration = useExecutionDuration(
    timing.id,
    timing.startedAt === undefined ? undefined : Date.parse(timing.startedAt),
    Date.parse(timing.endedAt),
  );
  const status =
    timing.status === undefined || timing.status === "succeeded"
      ? ""
      : `${timing.status} · `;
  const result = timing.recovered
    ? `${timing.status ?? "ended"} · End time unknown (recovered)`
    : `${status}Total ${duration ?? "—"}`;
  const label = origin ? `${origin} · ${result}` : result;
  return disclosure ? (
    <div className="ohb-run-header">
      <button
        type="button"
        className="ohb-prompt-duration ohb-run-disclosure"
        id={disclosure.id}
        aria-expanded={disclosure.open}
        aria-controls={disclosure.controls}
        onClick={disclosure.onToggle}
      >
        <span>{label}</span>
        <ChevronRight
          size={16}
          className="ohb-run-chevron"
          aria-hidden="true"
        />
      </button>
    </div>
  ) : (
    <div className="ohb-prompt-duration">{label}</div>
  );
}

/**
 * Why a turn failed, said once at its end and kept with the history: the
 * service's safe reason, plus the HTTP status when there was one, for anyone
 * reporting the problem. Quiet text rather than a card, and nothing to close.
 */
export function TurnError({
  error,
  relatedSubagents,
}: {
  readonly error: UiPromptError;
  readonly relatedSubagents?: readonly {
    readonly executionId: string;
    readonly label: string;
    readonly onOpen?: () => void;
  }[];
}): ReactElement {
  return (
    <div className="ohb-turn-error">
      <CircleAlert size={14} aria-hidden="true" />
      <p>
        {error.message}
        {relatedSubagents?.length ? (
          <small>
            Results that triggered this run:{" "}
            {relatedSubagents.map((source, index) => (
              <span key={source.executionId}>
                {index > 0 ? ", " : ""}
                {source.onOpen ? (
                  <button
                    type="button"
                    className="ohb-banner-action"
                    aria-label={`Open subagent ${source.label}`}
                    onClick={source.onOpen}
                  >
                    {source.label}
                  </button>
                ) : (
                  source.label
                )}
              </span>
            ))}
          </small>
        ) : null}
        {error.statusCode === undefined ? null : (
          <small>HTTP {error.statusCode}</small>
        )}
      </p>
    </div>
  );
}
