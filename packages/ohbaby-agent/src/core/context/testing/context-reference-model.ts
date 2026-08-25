import type { ChatCompletionMessage } from "../../llm-client/index.js";

export type ReferenceToolTerminalStatus = "aborted" | "completed" | "error";

export type ReferencePart =
  | {
      readonly id: string;
      readonly kind: "text";
      readonly text: string;
      readonly compacted: boolean;
      readonly summary: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "tool";
      readonly callId: string;
      readonly tool: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly compacted: boolean;
      readonly status: "pending" | ReferenceToolTerminalStatus;
      readonly result?: string;
    };

export interface ReferenceMessage {
  readonly id: string;
  readonly role: "assistant" | "user";
  readonly parts: readonly ReferencePart[];
}

export interface ReferenceContextState {
  readonly messages: readonly ReferenceMessage[];
}

export interface ReferenceCompactionCommit {
  readonly compactedPartIds: ReadonlySet<string>;
  readonly summaryMessageId: string;
  readonly summaryPartId: string;
  readonly summaryText: string;
}

export function createReferenceContextState(): ReferenceContextState {
  return { messages: [] };
}

export function recordReferenceMessage(
  state: ReferenceContextState,
  input: {
    readonly messageId: string;
    readonly partId: string;
    readonly role: "assistant" | "user";
    readonly text: string;
  },
): ReferenceContextState {
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        id: input.messageId,
        role: input.role,
        parts: [
          {
            compacted: false,
            id: input.partId,
            kind: "text",
            summary: false,
            text: input.text,
          },
        ],
      },
    ],
  };
}

export function appendReferenceText(
  state: ReferenceContextState,
  input: {
    readonly messageId: string;
    readonly partId: string;
    readonly text: string;
  },
): ReferenceContextState {
  return updateReferenceMessage(state, input.messageId, (message) => ({
    ...message,
    parts: [
      ...message.parts,
      {
        compacted: false,
        id: input.partId,
        kind: "text",
        summary: false,
        text: input.text,
      },
    ],
  }));
}

export function appendReferenceToolCall(
  state: ReferenceContextState,
  input: {
    readonly callId: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly messageId: string;
    readonly partId: string;
    readonly tool: string;
  },
): ReferenceContextState {
  return updateReferenceMessage(state, input.messageId, (message) => ({
    ...message,
    parts: [
      ...message.parts,
      {
        callId: input.callId,
        compacted: false,
        id: input.partId,
        input: structuredClone(input.input),
        kind: "tool",
        status: "pending",
        tool: input.tool,
      },
    ],
  }));
}

export function completeReferenceToolCall(
  state: ReferenceContextState,
  input: {
    readonly callId: string;
    readonly result: string;
    readonly status: ReferenceToolTerminalStatus;
  },
): ReferenceContextState {
  return updateReferencePart(state, input.callId, (part) => {
    if (part.kind !== "tool") {
      return part;
    }
    return { ...part, result: input.result, status: input.status };
  });
}

export function abortReferenceTools(
  state: ReferenceContextState,
  result: string,
): ReferenceContextState {
  return {
    ...state,
    messages: state.messages.map((message) => ({
      ...message,
      parts: message.parts.map((part) =>
        part.kind === "tool" && part.status === "pending"
          ? { ...part, result, status: "aborted" }
          : part,
      ),
    })),
  };
}

export function applyReferenceCompactionCommit(
  state: ReferenceContextState,
  input: ReferenceCompactionCommit,
): ReferenceContextState {
  const compactedMessages = state.messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) =>
      input.compactedPartIds.has(part.id) ? { ...part, compacted: true } : part,
    ),
  }));

  return {
    ...state,
    messages: [
      ...compactedMessages,
      {
        id: input.summaryMessageId,
        role: "assistant",
        parts: [
          {
            compacted: false,
            id: input.summaryPartId,
            kind: "text",
            summary: true,
            text: input.summaryText,
          },
        ],
      },
    ],
  };
}

export function projectReferenceHistory(
  state: ReferenceContextState,
): readonly ChatCompletionMessage[] {
  const activeSummaries = state.messages.filter((message) =>
    message.parts.some(
      (part) => part.kind === "text" && part.summary && !part.compacted,
    ),
  );
  const nonSummaries = state.messages.filter(
    (message) => !activeSummaries.includes(message),
  );

  return [...activeSummaries, ...nonSummaries].flatMap(
    (message): ChatCompletionMessage[] => {
      const active = message.parts.filter((part) => !part.compacted);
      const summaryText = active
        .filter(
          (part): part is Extract<ReferencePart, { kind: "text" }> =>
            part.kind === "text" && part.summary,
        )
        .map((part) => part.text)
        .join("");
      if (summaryText !== "") {
        return [
          {
            content: `<context_summary>\n${summaryText}\n</context_summary>`,
            role: "user" as const,
          },
        ];
      }

      const content = active
        .filter(
          (part): part is Extract<ReferencePart, { kind: "text" }> =>
            part.kind === "text" && !part.summary,
        )
        .map((part) => part.text)
        .join("");
      if (message.role === "user") {
        return content === "" ? [] : [{ content, role: "user" as const }];
      }

      const tools = active.filter(
        (part): part is Extract<ReferencePart, { kind: "tool" }> =>
          part.kind === "tool",
      );
      if (tools.length === 0) {
        return content === "" ? [] : [{ content, role: "assistant" as const }];
      }

      return [
        {
          content: content === "" ? null : content,
          role: "assistant" as const,
          tool_calls: tools.map((part) => ({
            function: {
              arguments: JSON.stringify(part.input),
              name: part.tool,
            },
            id: part.callId,
            type: "function" as const,
          })),
        },
        ...tools.map((part) => ({
          content:
            part.status === "pending"
              ? "Tool execution was interrupted before a durable result was recorded. Side effects may have occurred; verify before retrying."
              : (part.result ?? ""),
          role: "tool" as const,
          tool_call_id: part.callId,
        })),
      ];
    },
  );
}

export function getPendingReferenceCallIds(
  state: ReferenceContextState,
): readonly string[] {
  return state.messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.kind === "tool" && part.status === "pending" ? [part.callId] : [],
    ),
  );
}

export function getReferenceMessage(
  state: ReferenceContextState,
  messageId: string,
): ReferenceMessage | undefined {
  return state.messages.find((message) => message.id === messageId);
}

export function serializeReferenceTrace(actions: readonly unknown[]): string {
  return JSON.stringify(actions, undefined, 2);
}

function updateReferenceMessage(
  state: ReferenceContextState,
  messageId: string,
  update: (message: ReferenceMessage) => ReferenceMessage,
): ReferenceContextState {
  if (!state.messages.some((message) => message.id === messageId)) {
    throw new Error(`Reference message not found: ${messageId}`);
  }
  const messages = state.messages.map((message) =>
    message.id === messageId ? update(message) : message,
  );
  return { ...state, messages };
}

function updateReferencePart(
  state: ReferenceContextState,
  callId: string,
  update: (part: ReferencePart) => ReferencePart,
): ReferenceContextState {
  if (
    !state.messages.some((message) =>
      message.parts.some(
        (part) => part.kind === "tool" && part.callId === callId,
      ),
    )
  ) {
    throw new Error(`Reference tool call not found: ${callId}`);
  }
  const messages = state.messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.kind !== "tool" || part.callId !== callId) {
        return part;
      }
      return update(part);
    }),
  }));
  return { ...state, messages };
}
