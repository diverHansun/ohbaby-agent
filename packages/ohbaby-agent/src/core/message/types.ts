import type { ChatCompletionMessage } from "../llm-client/index.js";

export type MessageRole = "user" | "assistant" | "system";

export interface MessageTime {
  readonly created: number;
  readonly updated?: number;
  readonly completed?: number;
}

export interface PartTime {
  readonly compacted?: number;
}

interface MessageBase {
  readonly id: string;
  readonly sessionId: string;
  readonly role: MessageRole;
  readonly time: MessageTime;
}

export interface UserMessage extends MessageBase {
  readonly role: "user";
  readonly agent: string;
  readonly model?: {
    readonly providerId: string;
    readonly modelId: string;
  };
  readonly system?: string;
  readonly tools?: Record<string, boolean>;
}

export interface AssistantMessage extends MessageBase {
  readonly role: "assistant";
  readonly agent: string;
  readonly parentId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly finish?: string;
  readonly error?: MessageError;
}

export interface SystemMessage extends MessageBase {
  readonly role: "system";
  readonly kind: "abort" | "error" | "info";
  readonly agent?: string;
}

export type Message = UserMessage | AssistantMessage | SystemMessage;

export type MessageError =
  | {
      readonly name: "ProviderAuthError";
      readonly providerId: string;
      readonly message: string;
    }
  | { readonly name: "MessageOutputLengthError" }
  | { readonly name: "MessageAbortedError"; readonly message: string }
  | {
      readonly name: "APIError";
      readonly message: string;
      readonly statusCode?: number;
      readonly isRetryable: boolean;
    }
  | { readonly name: "Unknown"; readonly message: string };

export interface PartBase {
  readonly id: string;
  readonly messageId: string;
  readonly sessionId: string;
  readonly orderIndex: number;
  readonly time?: PartTime;
}

export interface TokenUsageMetadata {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface PartMetadata {
  readonly tokenUsage?: TokenUsageMetadata;
  readonly [key: string]: unknown;
}

export interface TextPart extends PartBase {
  readonly type: "text";
  readonly text: string;
  readonly synthetic?: boolean;
  readonly ignored?: boolean;
  readonly metadata?: PartMetadata;
}

export interface ReasoningPart extends PartBase {
  readonly type: "reasoning";
  readonly text: string;
  readonly metadata?: PartMetadata;
}

export interface ToolPart extends PartBase {
  readonly type: "tool";
  readonly callId: string;
  readonly tool: string;
  readonly state: ToolState;
  readonly metadata?: PartMetadata;
}

export type ToolState =
  | {
      readonly status: "pending";
      readonly input: Record<string, unknown>;
      readonly raw: string;
    }
  | {
      readonly status: "running";
      readonly input: Record<string, unknown>;
      readonly title?: string;
    }
  | {
      readonly status: "completed";
      readonly input: Record<string, unknown>;
      readonly output: string;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly status: "error";
      readonly input: Record<string, unknown>;
      readonly error: string;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly status: "aborted";
      readonly input: Record<string, unknown>;
      readonly error: "Tool execution aborted by user";
      readonly output?: string;
      readonly metadata?: Record<string, unknown>;
    };

export type Part = TextPart | ReasoningPart | ToolPart;

export interface MessageWithParts {
  readonly info: Message;
  readonly parts: readonly Part[];
}

export type CreateMessageInput =
  | {
      readonly sessionId: string;
      readonly role: "user";
      readonly agent: string;
      readonly model?: UserMessage["model"];
      readonly system?: string;
      readonly tools?: Record<string, boolean>;
    }
  | {
      readonly sessionId: string;
      readonly role: "assistant";
      readonly agent: string;
      readonly parentId?: string;
      readonly providerId?: string;
      readonly modelId?: string;
    }
  | {
      readonly sessionId: string;
      readonly role: "system";
      readonly kind: SystemMessage["kind"];
      readonly agent?: string;
    };

export type UpdateMessagePatch = Partial<
  Pick<AssistantMessage, "finish" | "error"> & {
    readonly time: MessageTime;
  }
>;

export type CreatePartInput =
  | Omit<TextPart, keyof PartBase>
  | Omit<ReasoningPart, keyof PartBase>
  | Omit<ToolPart, keyof PartBase>;

export interface UpdatePartPatch {
  readonly text?: string;
  readonly delta?: string;
  readonly state?: ToolState;
  readonly time?: PartTime;
  readonly metadata?: PartMetadata;
}

export interface MessageIdGenerator {
  messageId(): string;
  partId(): string;
}

export interface MessageManager {
  createMessage(input: CreateMessageInput): Promise<Message>;
  updateMessage(messageId: string, patch: UpdateMessagePatch): Promise<Message>;
  appendPart(messageId: string, input: CreatePartInput): Promise<Part>;
  updatePart(partId: string, patch: UpdatePartPatch): Promise<Part>;
  listBySession(sessionId: string): Promise<MessageWithParts[]>;
  removeMessage(messageId: string): Promise<void>;
  removeMessages(sessionId: string): Promise<void>;
  toModelMessages(sessionId: string): Promise<ChatCompletionMessage[]>;
}

export interface MessageStore {
  insertMessage(message: Message): Promise<void>;
  getMessage(messageId: string): Promise<Message | undefined>;
  updateMessage(messageId: string, patch: UpdateMessagePatch): Promise<Message>;
  appendPart(input: {
    readonly message: Message;
    readonly partId: string;
    readonly data: CreatePartInput;
    readonly updatedAt: number;
  }): Promise<Part>;
  updatePart(
    partId: string,
    patch: Omit<UpdatePartPatch, "delta">,
    updatedAt: number,
  ): Promise<Part>;
  listBySession(sessionId: string): Promise<MessageWithParts[]>;
  deleteMessage(messageId: string): Promise<void>;
  deleteBySession(sessionId: string): Promise<void>;
}
