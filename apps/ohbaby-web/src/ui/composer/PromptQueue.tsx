import { Pencil, Trash2 } from "lucide-react";
import type { UiBackendClient, UiPromptSubmission } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { SteerButton } from "./SteerButton.js";

const COLLAPSED_QUEUE_LENGTH = 5;

/** Prompts queued behind the running turn, each with steer, edit and delete. */
export function PromptQueue(props: {
  readonly prompts: readonly UiPromptSubmission[];
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  readonly editingPromptId: string | undefined;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly activeRunId: string | undefined;
  readonly steer: UiBackendClient["steerQueuedPrompt"];
  readonly onEdit: (prompt: UiPromptSubmission) => void;
  readonly onCancel: (promptId: string) => void;
}): ReactElement | null {
  if (props.prompts.length === 0) return null;
  const visible = props.expanded
    ? props.prompts
    : props.prompts.slice(0, COLLAPSED_QUEUE_LENGTH);
  return (
    <section className="ohb-prompt-queue" aria-label="Queued prompts">
      <div className="ohb-prompt-queue-header">
        <span>Queued {String(props.prompts.length)}</span>
        {props.prompts.length > COLLAPSED_QUEUE_LENGTH ? (
          <button
            onClick={props.onToggleExpanded}
            title={
              props.expanded
                ? "Collapse queued prompts"
                : "Show all queued prompts"
            }
            type="button"
          >
            {props.expanded ? "Show less" : "Show all"}
          </button>
        ) : null}
      </div>
      <div className="ohb-prompt-queue-items">
        {visible.map((prompt) => {
          const editing = props.editingPromptId === prompt.promptId;
          return (
            <div
              className={`ohb-prompt-queue-item ${editing ? "is-editing" : ""}`}
              key={prompt.promptId}
            >
              <span className="ohb-prompt-queue-text">
                <span aria-hidden="true">↳ </span>
                <span>{prompt.text}</span>
                {prompt.status === "retained" ? (
                  <small> · Retained</small>
                ) : null}
                {editing ? <small> · editing</small> : null}
              </span>
              <SteerButton
                prompt={prompt}
                runId={props.activeRunId}
                disabled={props.busy || editing || props.disabled}
                steer={props.steer}
              />
              <button
                aria-label={`Edit prompt: ${prompt.text}`}
                title="Edit prompt"
                className="ohb-prompt-queue-edit"
                disabled={props.busy}
                onClick={() => {
                  props.onEdit(prompt);
                }}
                type="button"
              >
                <Pencil size={13} />
              </button>
              <button
                aria-label={`Delete prompt: ${prompt.text}`}
                className="ohb-prompt-queue-cancel"
                disabled={props.busy}
                onClick={() => {
                  props.onCancel(prompt.promptId);
                }}
                title="Delete prompt"
                type="button"
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
