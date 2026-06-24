import type {
  CoreAPI,
  UiCommandCatalog,
  UiCommandInvocation,
  UiCommandSpec,
  UiContextWindowUsage,
  UiEvent as SdkUiEvent,
  UiEventHandler,
  UiInteractionKind,
  UiMessage,
  UiNotice,
  UiPermissionState,
  UiPermissionRequest,
  UiRun,
  UiRunStatus,
  UiSession,
  UiSnapshot,
  UiUnsubscribe,
} from "ohbaby-sdk";
import type { TranscriptItem } from "./transcript.js";

export type TuiRuntimeStatus = UiRunStatus;

export type TuiCommandSpec = UiCommandSpec;

export type TuiCommandCatalog = UiCommandCatalog;

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
  readonly sessionId?: string;
  readonly text: string;
}

export interface TuiReasoningViewState {
  readonly content: string;
  readonly folded: boolean;
}

export interface TuiInteractionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly metadata?: Record<string, unknown>;
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
      readonly timestamp?: number;
    }
  | { readonly type: "snapshot.replaced"; readonly snapshot: UiSnapshot };

export type TuiEventHandler = (event: TuiEvent) => void;

export type TerminalClient = CoreAPI & {
  readonly subscribeEvents: (
    handler: TuiEventHandler | UiEventHandler,
  ) => UiUnsubscribe;
};

export interface TuiStoreState {
  readonly snapshot: UiSnapshot;
  readonly activeSessionId: string | null;
  readonly sessions: readonly UiSession[];
  readonly messages: readonly UiMessage[];
  readonly runs: readonly UiRun[];
  readonly permissions: readonly UiPermissionRequest[];
  readonly permission: UiPermissionState | undefined;
  readonly runtime: TuiRuntimeStatus;
  readonly interactions: readonly TuiInteractionRequest[];
  readonly notices: readonly UiNotice[];
  readonly commandNotices: readonly TuiCommandNotice[];
  readonly commandSessionIds: Readonly<Record<string, string | null>>;
  readonly committedItems: readonly TranscriptItem[];
  readonly committedPartCounts: Readonly<Partial<Record<string, number>>>;
  readonly liveMessage: UiMessage | null;
  readonly reasoningByMessageId: Readonly<
    Record<string, TuiReasoningViewState>
  >;
  readonly contextWindowUsages: readonly UiContextWindowUsage[];
  readonly commandNoticeSequence: number;
  readonly resolvedPermissionIds: readonly string[];
  readonly catalog: TuiCommandCatalog | null;
  readonly catalogInvalidation: TuiCommandCatalogInvalidation | null;
}

export interface TuiStore {
  readonly getState: () => TuiStoreState;
  readonly dispatch: (event: TuiEvent) => void;
  readonly dispatchMany: (events: readonly TuiEvent[]) => void;
  readonly replaceSnapshot: (snapshot: UiSnapshot) => void;
  readonly setCatalog: (catalog: TuiCommandCatalog) => void;
  readonly subscribe: (listener: () => void) => () => void;
}
