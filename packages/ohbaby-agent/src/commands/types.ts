import type {
  UiCommandAction,
  UiCommandCatalog,
  UiCommandError,
  UiCommandInvocation,
  UiCommandOutput,
  UiCommandSpec,
  UiCommandSurface,
  UiCompactSessionResult,
  UiConnectModelInput,
  UiConnectModelResult,
  UiContextWindowUsage,
  UiInteractionResponse,
  UiSnapshot,
} from "ohbaby-sdk";
import type { BusInstance } from "../bus/index.js";
import type {
  InteractionBroker,
  InteractionRequestContext,
  InteractionRequestInput,
} from "../runtime/interaction-broker/index.js";
import type { ContextUsage } from "../core/context/index.js";
import type { InterfaceProviderKind } from "../config/llm/types.js";

export interface CommandToolSummary {
  readonly name: string;
  readonly description: string;
  readonly category?: string;
  readonly source?: string;
}

export type CommandSkillScope = "user" | "project";

export interface CommandSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly scope: CommandSkillScope;
  readonly source?: string;
}

export type CommandMcpServerStatus =
  | "connected"
  | "failed"
  | "disconnected"
  | "disabled";

export interface CommandMcpServerSummary {
  readonly name: string;
  readonly status: CommandMcpServerStatus;
}

export interface CommandModelSummary {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly model?: string;
  readonly interfaceProvider?: InterfaceProviderKind;
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly active?: boolean;
}

export interface CommandModelSwitchInput {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly apiKey?: string;
}

export interface CommandSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly created?: boolean;
}

export interface CommandToolProvider {
  listTools():
    | Promise<readonly CommandToolSummary[]>
    | readonly CommandToolSummary[];
}

export interface CommandMcpProvider {
  listServers():
    | Promise<readonly CommandMcpServerSummary[]>
    | readonly CommandMcpServerSummary[];
}

export interface CommandModelProvider {
  listModels():
    | Promise<readonly CommandModelSummary[]>
    | readonly CommandModelSummary[];
  currentModel():
    | Promise<CommandModelSummary | null>
    | CommandModelSummary
    | null;
  switchModel?(
    input: CommandModelSwitchInput,
  ): Promise<CommandModelSummary> | CommandModelSummary;
}

export interface CommandSessionProvider {
  listSessions():
    | Promise<readonly CommandSessionSummary[]>
    | readonly CommandSessionSummary[];
  createSession?(options?: {
    readonly reuseInactiveEmptySessions?: boolean;
  }): Promise<CommandSessionSummary> | CommandSessionSummary;
  selectSession?(sessionId: string): Promise<void> | void;
}

export interface CommandCompactProvider {
  compactSession(input: {
    readonly sessionId?: string;
    readonly force?: boolean;
  }): Promise<UiCompactSessionResult> | UiCompactSessionResult;
}

export interface CommandSkillProvider {
  listUserInvocable():
    | Promise<readonly CommandSkillSummary[]>
    | readonly CommandSkillSummary[];
  loadPrompt(name: string): Promise<string> | string;
}

export type CommandPermissionState = NonNullable<UiSnapshot["permission"]>;

export interface CommandPermissionProvider {
  getState(): CommandPermissionState;
  setMode(mode: CommandPermissionState["mode"]): Promise<void> | void;
  toggleMode():
    | Promise<CommandPermissionState["mode"]>
    | CommandPermissionState["mode"];
  setLevel(level: CommandPermissionState["level"]): Promise<void> | void;
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
  readonly compact?: CommandCompactProvider;
  readonly skills?: CommandSkillProvider;
  readonly mcps?: CommandMcpProvider;
  readonly permission?: CommandPermissionProvider;
  readonly abortRun?: (runId?: string) => Promise<void> | void;
  readonly submitPrompt?: (
    text: string,
    options?: { readonly sessionId?: string },
  ) => Promise<void> | void;
  readonly connectModel?: (
    input: UiConnectModelInput,
  ) => Promise<UiConnectModelResult> | UiConnectModelResult;
  readonly exit?: () => Promise<void> | void;
  readonly getStatus?: () => string;
  readonly getContextUsage?: (input: {
    readonly sessionId?: string;
  }) => Promise<ContextUsage | null> | ContextUsage | null;
  readonly getContextWindowUsage?: (input: {
    readonly sessionId: string;
  }) => Promise<UiContextWindowUsage | null> | UiContextWindowUsage | null;
  readonly getProjectRoot?: () => Promise<string> | string;
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
