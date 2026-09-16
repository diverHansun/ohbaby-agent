import { isModelContextPart } from "./origin.js";
import type {
  AssistantMessage,
  MessageManager,
  Part,
  TextPart,
} from "./types.js";
import type { TokenUsage } from "../llm-client/types.js";
import { createTokenUsageMetadata } from "./token-usage-metadata.js";

/** Historical facts, never instructions or replacement model output. */
export const INTERRUPTION_TEXT = {
  MessageOutputLengthError: "[Response incomplete: output limit reached.]",
  MessageContentFilterError: "[Response incomplete: content was filtered.]",
  MessageStreamInterruptedError:
    "[Response interrupted: the saved text below may be incomplete.]",
  MessageAbortedError: "[Response cancelled by the user.]",
} as const;

export function isInterruptionFactPart(part: Part): part is TextPart {
  return (
    part.type === "text" &&
    part.synthetic === true &&
    part.metadata?.kind === "lifecycle-interruption"
  );
}

export function isVisibleAssistantTextPart(part: Part): part is TextPart {
  return (
    part.type === "text" &&
    part.time?.compacted === undefined &&
    part.ignored !== true &&
    part.synthetic !== true &&
    !isModelContextPart(part)
  );
}

/** Attach a fact only when the existing saved body cannot carry it. */
export async function ensureInterruptionFact(
  manager: MessageManager,
  message: AssistantMessage,
  name: keyof typeof INTERRUPTION_TEXT,
  tokenUsage?: TokenUsage,
): Promise<void> {
  const saved = (
    await manager.listBySession(message.sessionId, {
      contextScopeId: message.contextScopeId,
    })
  ).find((item) => item.info.id === message.id);
  if (!saved || saved.parts.some(isInterruptionFactPart)) return;
  if (
    name !== "MessageAbortedError" &&
    saved.parts.some(
      (part) => isVisibleAssistantTextPart(part) && part.text !== "",
    )
  )
    return;
  await manager.appendPart(message.id, {
    type: "text",
    text: INTERRUPTION_TEXT[name],
    synthetic: true,
    metadata: {
      kind: "lifecycle-interruption",
      ...(tokenUsage === undefined ? {} : createTokenUsageMetadata(tokenUsage)),
    },
  });
}
