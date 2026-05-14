import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiCommand,
  UiEvent as SdkUiEvent,
  UiEventHandler,
  UiMessage,
  UiPermissionRequest,
  UiPermissionResponse,
  UiRun,
  UiRunStatus,
  UiSession,
  UiSnapshot,
  UiUnsubscribe,
} from "ohbaby-sdk";

export type TuiRuntimeStatus = UiRunStatus;

export interface TuiCommandSpec {
  readonly id: string;
  readonly path: readonly string[];
  readonly description: string;
  readonly title?: string;
  readonly aliases?: readonly (readonly string[])[];
  readonly surfaces?: readonly string[];
  readonly category?: string;
  readonly acceptsArguments?: boolean;
}

export interface TuiCommandCatalog {
  readonly version: string;
  readonly surface: string;
  readonly commands: readonly TuiCommandSpec[];
  readonly loadedAt: number;
}

export interface TuiCommandCatalogInvalidation {
  readonly version?: string;
  readonly reason?: string;
}

export interface TuiCommandInvocation {
  readonly clientInvocationId: string;
  readonly commandId: string;
  readonly path: readonly string[];
  readonly raw: string;
  readonly rawArgs: string;
  readonly argv: readonly string[];
  readonly surface: "tui";
  readonly sessionId?: string;
}

export interface TuiCommandNotice {
  readonly id: string;
  readonly kind: "result" | "error";
  readonly commandId: string;
  readonly clientInvocationId?: string;
  readonly text: string;
}

export interface TuiInteractionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export type TuiInteractionSubject = string;

export interface TuiInteractionRequest {
  readonly interactionId: string;
  readonly kind: "select-one" | "confirm";
  readonly subject: TuiInteractionSubject;
  readonly title?: string;
  readonly message?: string;
  readonly options?: readonly TuiInteractionOption[];
}

export type TuiInteractionResponse =
  | { readonly kind: "accepted"; readonly choiceId?: string }
  | { readonly kind: "confirmed" }
  | { readonly kind: "cancelled" };

export type TuiCommandResultEvent =
  | {
      readonly type: "command.result.delivered";
      readonly commandId: string;
      readonly clientInvocationId?: string;
      readonly output: string;
    }
  | {
      readonly type: "command.result.failed" | "command.failed";
      readonly commandId: string;
      readonly clientInvocationId?: string;
      readonly error: { readonly message: string } | string;
    };

export type TuiEvent =
  | SdkUiEvent
  | { readonly type: "snapshot.replaced"; readonly snapshot: UiSnapshot }
  | { readonly type: "runtime.updated"; readonly runtime: TuiRuntimeStatus }
  | {
      readonly type: "message.part.delta";
      readonly sessionId: string;
      readonly messageId: string;
      readonly partIndex?: number;
      readonly partId?: string;
      readonly delta: string;
    }
  | TuiCommandResultEvent
  | {
      readonly type: "command.catalog.updated";
      readonly version?: string;
      readonly reason?: string;
    }
  | {
      readonly type: "interaction.requested";
      readonly interaction: TuiInteractionRequest;
    }
  | {
      readonly type: "interaction.resolved";
      readonly interactionId: string;
    };

export type TuiEventHandler = (event: TuiEvent) => void;

export type TuiBackendClient = Omit<
  UiBackendClient,
  "executeCommand" | "subscribeEvents"
> & {
  readonly getSnapshot: () => Promise<UiSnapshot>;
  readonly subscribeEvents: (
    handler: TuiEventHandler | UiEventHandler,
  ) => UiUnsubscribe;
  readonly submitPrompt: (
    text: string,
    options?: SubmitPromptOptions,
  ) => Promise<void>;
  readonly executeCommand: (
    command: UiCommand | TuiCommandInvocation,
  ) => Promise<void>;
  readonly respondPermission: (
    requestId: string,
    response: UiPermissionResponse,
  ) => Promise<void>;
  readonly listCommands?: (options?: {
    readonly surface?: string;
  }) => Promise<TuiCommandCatalog | readonly TuiCommandSpec[]>;
  readonly respondInteraction?: (
    interactionId: string,
    response: TuiInteractionResponse,
  ) => Promise<void>;
};

export interface TuiStoreState {
  readonly snapshot: UiSnapshot;
  readonly activeSessionId: string | null;
  readonly sessions: readonly UiSession[];
  readonly messages: readonly UiMessage[];
  readonly runs: readonly UiRun[];
  readonly permissions: readonly UiPermissionRequest[];
  readonly runtime: TuiRuntimeStatus;
  readonly interactions: readonly TuiInteractionRequest[];
  readonly commandNotices: readonly TuiCommandNotice[];
  readonly commandNoticeSequence: number;
  readonly catalog: TuiCommandCatalog | null;
  readonly catalogInvalidation: TuiCommandCatalogInvalidation | null;
}

export interface TuiStore {
  readonly getState: () => TuiStoreState;
  readonly dispatch: (event: TuiEvent) => void;
  readonly replaceSnapshot: (snapshot: UiSnapshot) => void;
  readonly setCatalog: (catalog: TuiCommandCatalog) => void;
  readonly subscribe: (listener: () => void) => () => void;
}
