import type { UiMessage, UiMessagePart } from "ohbaby-sdk";
import type { ReactElement } from "react";
import type { ReasoningViewState } from "../../api/daemon/wire.js";
import { MarkdownBlock } from "../shared/MarkdownBlock.js";
import { OrphanToolResultCard, pairToolParts, ToolCard } from "./tool-card.js";

export function MessageRow(props: {
  readonly message: UiMessage;
  readonly reasoning?: ReasoningViewState;
}): ReactElement | null {
  const isUser = props.message.role === "user";
  const visibleParts = filterTodoToolParts(props.message.parts);
  const pairedParts = pairToolParts(visibleParts);
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
        {props.reasoning ? (
          <details className="ohb-reasoning" open={!props.reasoning.folded}>
            <summary>Thought</summary>
            <pre>{props.reasoning.content}</pre>
          </details>
        ) : null}
        {pairedParts.map((entry) => {
          if (entry.kind === "tool") {
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
            <MessagePart
              isStreaming={props.message.status === "streaming"}
              key={`${props.message.id}-${messagePartKey(
                visibleParts,
                entry.sourceIndex,
              )}`}
              part={entry.part}
            />
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
        <details
          className="ohb-reasoning"
          open={props.part.endReason === undefined}
        >
          <summary>
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
          </summary>
          <pre>{props.part.text}</pre>
        </details>
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
