import type {
  SubmitPromptOptions,
  UiBackendClient,
  UiCommandArgumentMode,
  UiCommandCatalog,
  UiCommandInvocation,
  UiCommandParentBehavior,
  UiCommandSource,
  UiCommandSurface,
  UiEvent as SdkUiEvent,
  UiEventHandler,
  UiInteractionKind,
  UiInteractionResponse,
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
  readonly argumentMode?: UiCommandArgumentMode;
  readonly source?: UiCommandSource;
  readonly title?: string;
  readonly aliases?: readonly (readonly string[])[];
  readonly surfaces?: readonly string[];
  readonly category?: string;
  readonly parentBehavior?: UiCommandParentBehavior;
  readonly acceptsArguments?: boolean;
}

export interface TuiCommandCatalog {
  readonly version: string;
  readonly surface?: string;
  readonly commands: readonly TuiCommandSpec[];
  readonly loadedAt?: number;
}

export interface TuiCommandCatalogInvalidation {
  readonly version?: string;
  readonly reason?: string;
}

export interface TuiCommandInvocation extends UiCommandInvocation {
  readonly surface: "tui";
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
  readonly kind: UiInteractionKind;
  readonly subject: TuiInteractionSubject;
  readonly title?: string;
  readonly message?: string;
  readonly options?: readonly TuiInteractionOption[];
}

export type TuiEvent =
  | SdkUiEvent
  | {
      readonly type: "message.part.delta";
      readonly sessionId: string;
      readonly messageId: string;
      readonly partId?: string;
      readonly delta: string;
      readonly content?: string;
    }
  | { readonly type: "snapshot.replaced"; readonly snapshot: UiSnapshot };

export type TuiEventHandler = (event: TuiEvent) => void;

export type TuiBackendClient = Omit<
  UiBackendClient,
  "executeCommand" | "listCommands" | "respondInteraction" | "subscribeEvents"
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
    command: UiCommandInvocation,
  ) => Promise<void>;
  readonly respondPermission: (
    requestId: string,
    response: UiPermissionResponse,
  ) => Promise<void>;
  readonly listCommands: (query: {
    readonly surface: UiCommandSurface;
  }) => Promise<UiCommandCatalog | TuiCommandCatalog | readonly TuiCommandSpec[]>;
  readonly respondInteraction?: (
    interactionId: string,
    response: UiInteractionResponse,
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
  readonly resolvedPermissionIds: readonly string[];
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
