import type { UiMessage, UiMessagePart } from "ohbaby-sdk";
import { Fragment, useContext, type ReactElement, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { ConversationPresentation } from "./ConversationPresentation.js";
import type { ReasoningViewState } from "../../api/daemon/wire.js";
import { MarkdownBlock } from "../shared/MarkdownBlock.js";
import { OrphanToolResultCard, pairToolParts, ToolCard } from "./tool-card.js";

export function MessageRow(props: {
  readonly message: UiMessage;
  readonly reasoning?: ReasoningViewState;
  readonly beforeText?: ReactNode;
  readonly reasoningHidden?: boolean;
  readonly reasoningIdPrefix?: string;
}): ReactElement | null {
  const presentation = useContext(ConversationPresentation);
  const delegation = presentation.executions?.find(
    (item) => item.childUserMessageId === props.message.id,
  );
  const isUser = props.message.role === "user";
  const visibleParts = filterTodoToolParts(props.message.parts);
  const pairedParts = pairToolParts(visibleParts);
  const firstText = pairedParts.findIndex(
    (entry) => entry.kind === "part" && entry.part.type === "text",
  );
  if (
    props.reasoning === undefined &&
    props.message.parts.length > 0 &&
    visibleParts.length === 0
  ) {
    return null;
  }
  return (
    <article
      aria-label={`${messageRoleLabel(props.message.role)} message`}
      className={`ohb-message ohb-message-${props.message.role}`}
    >
      <div
        className={`ohb-message-body ${
          isUser ? "ohb-message-user-bubble" : "ohb-message-assistant-bare"
        }`}
      >
        {isUser && presentation.fromParent ? (
          <div className="ohb-parent-source">
            From parent
            {delegation?.status === "queued" ? <span>Queued</span> : null}
          </div>
        ) : null}
        {props.reasoning ? (
          <ReasoningDetails
            open={!props.reasoning.folded}
            label="Thought"
            hidden={props.reasoningHidden}
            id={
              props.reasoningIdPrefix
                ? `${props.reasoningIdPrefix}-live`
                : undefined
            }
            text={props.reasoning.content}
          />
        ) : null}
        {pairedParts.map((entry, index) => {
          if (entry.kind === "tool") {
            const custom = presentation.renderTool?.(
              props.message,
              entry.call,
              entry.result,
            );
            if (custom !== undefined)
              return (
                <div key={`${props.message.id}-tool-${entry.call.id}`}>
                  {custom}
                </div>
              );
            return (
              <ToolCard
                call={entry.call}
                key={`${props.message.id}-tool-${entry.call.id}`}
                result={entry.result}
              />
            );
          }
          if (entry.kind === "orphan-result") {
            return (
              <OrphanToolResultCard
                key={`${props.message.id}-orphan-result-${entry.result.callId}`}
                result={entry.result}
              />
            );
          }
          return (
            <Fragment
              key={`${props.message.id}-${messagePartKey(visibleParts, entry.sourceIndex)}`}
            >
              {index === firstText ? props.beforeText : null}
              <MessagePart
                isStreaming={props.message.status === "streaming"}
                part={entry.part}
                hidden={
                  entry.part.type === "reasoning" && props.reasoningHidden
                }
                id={
                  entry.part.type === "reasoning" && props.reasoningIdPrefix
                    ? `${props.reasoningIdPrefix}-${String(entry.sourceIndex)}`
                    : undefined
                }
              />
            </Fragment>
          );
        })}
      </div>
    </article>
  );
}

function messageRoleLabel(role: UiMessage["role"]): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    case "tool":
      return "Tool";
  }
}

function messagePartKey(
  parts: readonly UiMessagePart[],
  index: number,
): string {
  const part = parts[index];
  if (part.id) return part.id;
  if (part.type === "tool-call") {
    return `tool-call-${part.call.id}`;
  }
  if (part.type === "tool-result") {
    return `tool-result-${part.result.callId}`;
  }
  const typeIndex = parts
    .slice(0, index)
    .filter((candidate) => candidate.type === part.type).length;
  return `${part.type}-${String(typeIndex)}`;
}

function filterTodoToolParts(
  parts: readonly UiMessagePart[],
): readonly UiMessagePart[] {
  const hiddenCallIds = new Set(
    parts
      .filter(
        (part) =>
          part.type === "tool-call" &&
          (part.call.name === "todo_read" || part.call.name === "todo_write"),
      )
      .map((part) => (part.type === "tool-call" ? part.call.id : "")),
  );
  if (hiddenCallIds.size === 0) {
    return parts;
  }
  return parts.filter(
    (part) =>
      !(
        (part.type === "tool-call" && hiddenCallIds.has(part.call.id)) ||
        (part.type === "tool-result" && hiddenCallIds.has(part.result.callId))
      ),
  );
}

export function filterTodoToolMessages(
  messages: readonly UiMessage[],
): readonly UiMessage[] {
  const hiddenCallIds = new Set(
    messages
      .flatMap((message) => message.parts)
      .filter(
        (part) =>
          part.type === "tool-call" &&
          (part.call.name === "todo_read" || part.call.name === "todo_write"),
      )
      .map((part) => (part.type === "tool-call" ? part.call.id : "")),
  );
  if (hiddenCallIds.size === 0) {
    return messages;
  }

  return messages.flatMap((message) => {
    const parts = message.parts.filter(
      (part) =>
        !(
          (part.type === "tool-call" && hiddenCallIds.has(part.call.id)) ||
          (part.type === "tool-result" && hiddenCallIds.has(part.result.callId))
        ),
    );
    return parts.length === 0 ? [] : [{ ...message, parts }];
  });
}

function MessagePart(props: {
  readonly isStreaming: boolean;
  readonly part: UiMessagePart;
  readonly hidden?: boolean;
  readonly id?: string;
}): ReactElement {
  switch (props.part.type) {
    case "text":
      return props.isStreaming ? (
        <pre className="ohb-streaming-text">{props.part.text}</pre>
      ) : (
        <MarkdownBlock text={props.part.text} />
      );
    case "reasoning":
      return (
        <ReasoningDetails
          open={props.part.endReason === undefined}
          hidden={props.hidden}
          id={props.id}
          text={props.part.text}
          label={
            <>
              Thought
              {props.part.endReason === "interrupted"
                ? " · interrupted"
                : props.part.endReason === "failed"
                  ? " · failed"
                  : ""}
              {props.part.saveState === "pending"
                ? " · saving"
                : props.part.saveState === "failed"
                  ? " · not saved"
                  : ""}
            </>
          }
        />
      );
    case "tool-call":
      return <ToolCard call={props.part.call} result={undefined} />;
    case "tool-result":
      return <OrphanToolResultCard result={props.part.result} />;
  }
}

export function visibleMessageText(message: UiMessage): string {
  return message.parts
    .map((part) =>
      part.type === "text" || part.type === "reasoning" ? part.text : "",
    )
    .join("");
}

function ReasoningDetails(props: {
  readonly open: boolean;
  readonly label: ReactNode;
  readonly text: string;
  readonly hidden?: boolean;
  readonly id?: string;
}): ReactElement {
  return (
    <details
      className="ohb-reasoning"
      open={props.open}
      hidden={props.hidden}
      id={props.id}
    >
      <summary>
        <span>{props.label}</span>
        <ChevronRight
          size={12}
          className="ohb-thought-chevron"
          aria-hidden="true"
        />
      </summary>
      <pre>{props.text}</pre>
    </details>
  );
}
