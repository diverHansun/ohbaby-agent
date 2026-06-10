import type { MessageWithParts } from "../../core/message/index.js";
import {
  createTemporarySessionTitle,
  isDefaultSessionTitle,
} from "./prompt-sanitizer.js";

export function createFallbackSessionTitleFromMessages(
  messages: readonly MessageWithParts[],
): string | null {
  for (const message of messages) {
    if (message.info.role !== "user") {
      continue;
    }

    const text = message.parts
      .flatMap((part) =>
        part.type === "text" && part.ignored !== true ? [part.text] : [],
      )
      .join(" ")
      .trim();
    if (text !== "") {
      return createTemporarySessionTitle(text);
    }
  }

  return null;
}

export function resolveSessionDisplayTitle(input: {
  readonly messages: readonly MessageWithParts[];
  readonly title: string;
}): string {
  if (!isDefaultSessionTitle(input.title)) {
    return input.title;
  }
  return createFallbackSessionTitleFromMessages(input.messages) ?? input.title;
}
