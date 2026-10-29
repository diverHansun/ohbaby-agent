import type { MessageWithParts, RuntimeInputOrigin } from "./types.js";

/** Construct persisted runtime context with the same provenance at every entry point. */
export function buildRuntimeInputMessage(input: {
  readonly messageId: string;
  readonly sessionId: string;
  readonly contextScopeId?: string;
  readonly agent: string;
  readonly createdAt: number;
  readonly origin: RuntimeInputOrigin;
  readonly text: string;
}): MessageWithParts {
  return {
    info: {
      id: input.messageId,
      sessionId: input.sessionId,
      contextScopeId: input.contextScopeId,
      runId: input.origin.targetRunId,
      role: "user",
      agent: input.agent,
      time: { created: input.createdAt },
      runtimeInput: input.origin,
    },
    parts: [
      {
        id: `${input.messageId}:text`,
        messageId: input.messageId,
        sessionId: input.sessionId,
        contextScopeId: input.contextScopeId,
        orderIndex: 0,
        type: "text",
        text: input.text,
      },
    ],
  };
}
