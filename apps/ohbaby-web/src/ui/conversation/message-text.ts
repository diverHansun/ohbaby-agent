import type { UiMessage } from "ohbaby-sdk";

/**
 * The message as the reader sees its prose: text parts only, joined by a
 * blank line. Thinking and tool calls stay out (copy topic 00 §2), unlike
 * `visibleMessageText`, which also carries reasoning. So do the notes the
 * runtime appends when a reply is stopped or cut off: they stay on screen but
 * are not the model's words (turn-projection 02 §2.2).
 */
export function messageBodyText(message: UiMessage): string {
  return message.parts
    .flatMap((part) =>
      part.type === "text" && part.metadata?.kind !== "lifecycle-interruption"
        ? [part.text.trim()]
        : [],
    )
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** A context summary left by compaction; it reads as a notice, not a message. */
export function isCompactionMessage(message: UiMessage): boolean {
  return message.parts.some(
    (part) => part.metadata?.kind === "context-compaction",
  );
}
