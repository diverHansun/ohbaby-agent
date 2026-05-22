import type { BusInstance } from "../../bus/index.js";
import type {
  UiInteractionKind,
  UiInteractionOption,
  UiInteractionRequest,
  UiInteractionResponse,
  UiInteractionSubject,
} from "ohbaby-sdk";

export interface InteractionBrokerOptions {
  readonly bus: BusInstance;
  readonly createInteractionId?: () => string;
  readonly now?: () => number;
}

export interface InteractionRequestInput {
  readonly kind: UiInteractionKind;
  readonly subject: UiInteractionSubject;
  readonly prompt?: string;
  readonly options?: readonly UiInteractionOption[];
  readonly defaultValue?: string | boolean | readonly string[];
}

export interface InteractionRequestContext {
  readonly commandRunId: string;
  readonly clientInvocationId?: string;
  readonly sessionId?: string;
}

export interface PendingInteractionSummary {
  readonly interactionId: string;
  readonly commandRunId: string;
  readonly clientInvocationId?: string;
  readonly sessionId?: string;
  readonly subject: string;
  readonly createdAt: number;
}

export interface PendingInteraction {
  readonly interactionId: string;
  readonly commandRunId: string;
  readonly clientInvocationId?: string;
  readonly sessionId?: string;
  readonly createdAt: number;
  readonly request: UiInteractionRequest;
  resolve(response: UiInteractionResponse): void;
}

export interface InteractionBroker {
  request(
    request: InteractionRequestInput,
    context: InteractionRequestContext,
  ): Promise<UiInteractionResponse>;
  respond(
    interactionId: string,
    response: UiInteractionResponse,
  ): Promise<void>;
  abortByCommandRun(commandRunId: string, reason: string): number;
  abortAll(reason: string): number;
  listPending(): readonly PendingInteractionSummary[];
}

export type InteractionBrokerErrorCode =
  | "INTERACTION_NOT_FOUND"
  | "INVALID_INTERACTION_RESPONSE";

export class InteractionBrokerError extends Error {
  readonly code: InteractionBrokerErrorCode;

  constructor(code: InteractionBrokerErrorCode, message: string) {
    super(message);
    this.name = "InteractionBrokerError";
    this.code = code;
  }
}
