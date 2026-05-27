export type UiInteractionKind =
  | "select-one"
  | "select-many"
  | "confirm"
  | "text-input";

export type UiInteractionSubject =
  | "model"
  | "session"
  | "permission"
  | (string & {});

export interface UiInteractionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface UiInteractionRequest {
  readonly interactionId: string;
  readonly commandRunId: string;
  readonly clientInvocationId?: string;
  readonly sessionId?: string;
  readonly kind: UiInteractionKind;
  readonly subject: UiInteractionSubject;
  readonly prompt?: string;
  readonly options?: readonly UiInteractionOption[];
  readonly defaultValue?: string | boolean | readonly string[];
}

export type UiInteractionResponse =
  | {
      readonly kind: "accepted";
      readonly choiceId?: string;
      readonly choiceIds?: readonly string[];
      readonly value?: string | boolean;
    }
  | {
      readonly kind: "cancelled";
      readonly reason: "user-cancelled" | "aborted" | "timeout" | (string & {});
    };
