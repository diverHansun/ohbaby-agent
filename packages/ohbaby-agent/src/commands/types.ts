import type {
  UiCommandAction,
  UiCommandCatalog,
  UiCommandError,
  UiCommandInvocation,
  UiCommandOutput,
  UiCommandSpec,
  UiCommandSurface,
  UiInteractionResponse,
} from "ohbaby-sdk";
import type { BusInstance } from "../bus/index.js";
import type {
  InteractionBroker,
  InteractionRequestContext,
  InteractionRequestInput,
} from "../runtime/interaction-broker/index.js";

export interface CommandToolSummary {
  readonly name: string;
  readonly description: string;
  readonly category?: string;
  readonly source?: string;
}

export interface CommandModelSummary {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
}

export interface CommandSessionSummary {
  readonly id: string;
  readonly title: string;
}

export interface CommandToolProvider {
  listTools(): Promise<readonly CommandToolSummary[]> | readonly CommandToolSummary[];
}

export interface CommandModelProvider {
  listModels(): Promise<readonly CommandModelSummary[]> | readonly CommandModelSummary[];
  currentModel(): Promise<CommandModelSummary | null> | CommandModelSummary | null;
}

export interface CommandSessionProvider {
  listSessions():
    | Promise<readonly CommandSessionSummary[]>
    | readonly CommandSessionSummary[];
  selectSession?(sessionId: string): Promise<void> | void;
}

export interface CommandRunContext {
  readonly commandRunId: string;
  readonly clientInvocationId: string;
  readonly sessionId?: string;
  readonly surface: UiCommandSurface;
  emitOutput(output: UiCommandOutput): void;
  emitAction(action: UiCommandAction): void;
  fail(error: UiCommandError): void;
  requestInteraction(
    request: InteractionRequestInput,
  ): Promise<UiInteractionResponse>;
}

export interface CommandHandler {
  readonly id: string;
  execute(
    invocation: UiCommandInvocation,
    context: CommandRunContext,
  ): Promise<void> | void;
}

export interface CommandServiceOptions {
  readonly bus: BusInstance;
  readonly interactionBroker?: Pick<InteractionBroker, "request"> &
    Partial<Pick<InteractionBroker, "abortByCommandRun">>;
  readonly tools?: CommandToolProvider;
  readonly models?: CommandModelProvider;
  readonly sessions?: CommandSessionProvider;
  readonly abortRun?: (runId?: string) => Promise<void> | void;
  readonly exit?: () => Promise<void> | void;
  readonly getStatus?: () => string;
  readonly createCommandRunId?: () => string;
  readonly now?: () => number;
  readonly extraCommands?: readonly UiCommandSpec[];
}

export interface CommandService {
  listCommands(query: { readonly surface?: UiCommandSurface }): UiCommandCatalog;
  executeCommand(invocation: UiCommandInvocation): Promise<void>;
  abortCommandRun(commandRunId: string, reason?: string): number;
}

export type CommandInteractionRequest = InteractionRequestInput;
export type CommandInteractionContext = InteractionRequestContext;
