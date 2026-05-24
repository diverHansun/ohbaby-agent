import type {
  UiCommandAction,
  UiCommandCatalog,
  UiCommandError,
  UiCommandInvocation,
  UiCommandOutput,
  UiCommandSpec,
  UiCommandSurface,
  UiInteractionResponse,
  UiSnapshot,
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

export interface CommandSkillSummary {
  readonly name: string;
  readonly description: string;
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
  listTools():
    | Promise<readonly CommandToolSummary[]>
    | readonly CommandToolSummary[];
}

export interface CommandModelProvider {
  listModels():
    | Promise<readonly CommandModelSummary[]>
    | readonly CommandModelSummary[];
  currentModel():
    | Promise<CommandModelSummary | null>
    | CommandModelSummary
    | null;
}

export interface CommandSessionProvider {
  listSessions():
    | Promise<readonly CommandSessionSummary[]>
    | readonly CommandSessionSummary[];
  selectSession?(sessionId: string): Promise<void> | void;
}

export interface CommandSkillProvider {
  listUserInvocable():
    | Promise<readonly CommandSkillSummary[]>
    | readonly CommandSkillSummary[];
  loadPrompt(name: string): Promise<string> | string;
}

export type CommandPolicyState = NonNullable<UiSnapshot["policy"]>;

export interface CommandPolicyProvider {
  getState(): CommandPolicyState;
  setMode(mode: CommandPolicyState["mode"]): Promise<void> | void;
  setAgentState(state: CommandPolicyState["agentState"]): Promise<void> | void;
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
  readonly skills?: CommandSkillProvider;
  readonly policy?: CommandPolicyProvider;
  readonly abortRun?: (runId?: string) => Promise<void> | void;
  readonly submitPrompt?: (
    text: string,
    options?: { readonly sessionId?: string },
  ) => Promise<void> | void;
  readonly exit?: () => Promise<void> | void;
  readonly getStatus?: () => string;
  readonly createCommandRunId?: () => string;
  readonly now?: () => number;
  readonly extraCommands?: readonly UiCommandSpec[];
  readonly extraHandlers?: readonly CommandHandler[];
}

export interface CommandService {
  listCommands(query: {
    readonly surface?: UiCommandSurface;
  }): Promise<UiCommandCatalog>;
  executeCommand(invocation: UiCommandInvocation): Promise<void>;
  abortCommandRun(commandRunId: string, reason?: string): number;
}

export type CommandInteractionRequest = InteractionRequestInput;
export type CommandInteractionContext = InteractionRequestContext;
