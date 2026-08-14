import type {
  CoreAPI,
  SDKAPI,
  UiCommandCatalog,
  UiCommandInvocation,
  UiCommandSpec,
  UiContextWindowUsage,
  UiEvent,
  UiInteractionKind,
  UiMessage,
  UiNotice,
  UiPermissionState,
  UiPermissionRequest,
  UiPromptSubmission,
  UiRun,
  UiRunStatus,
  UiSession,
  UiSessionGoal,
  UiSessionTodoList,
  UiSnapshot,
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

export type TerminalClient = CoreAPI & SDKAPI;

export interface TuiStoreState {
  readonly snapshot: UiSnapshot;
  readonly activeSessionId: string | null;
  readonly sessions: readonly UiSession[];
  readonly messages: readonly UiMessage[];
  readonly runs: readonly UiRun[];
  readonly permissions: readonly UiPermissionRequest[];
  readonly permission: UiPermissionState | undefined;
  readonly prompts: readonly UiPromptSubmission[];
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
  readonly goals: readonly UiSessionGoal[];
  readonly todos: readonly UiSessionTodoList[];
  readonly commandNoticeSequence: number;
  readonly resolvedPermissionIds: readonly string[];
  readonly catalog: TuiCommandCatalog | null;
  readonly catalogInvalidation: TuiCommandCatalogInvalidation | null;
}

export interface TuiStore {
  readonly getState: () => TuiStoreState;
  readonly dispatch: (event: UiEvent) => void;
  readonly dispatchMany: (events: readonly UiEvent[]) => void;
  readonly replaceSnapshot: (snapshot: UiSnapshot) => void;
  readonly setCatalog: (catalog: TuiCommandCatalog) => void;
  readonly subscribe: (listener: () => void) => () => void;
}
