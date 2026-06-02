export type UiSlashCommandSurface =
  | "tui"
  | "stdout"
  | "headless"
  | "remote"
  | (string & {});

export type UiSlashCommandArgumentMode = "raw" | "argv" | "structured";

export type UiSlashCommandSource =
  | "builtin"
  | "user"
  | "mcp"
  | "skill"
  | "plugin";

export type UiSlashCommandParentBehavior = "interaction" | "help" | "none";

export interface UiSlashCommandSpec {
  readonly id: string;
  readonly path: readonly string[];
  readonly aliases?: readonly (readonly string[])[];
  readonly title?: string;
  readonly category: string;
  readonly description: string;
  readonly argsHint?: string;
  readonly acceptsArguments?: boolean;
  readonly argumentMode: UiSlashCommandArgumentMode;
  readonly source: UiSlashCommandSource;
  readonly surfaces: readonly UiSlashCommandSurface[];
  readonly parentBehavior?: UiSlashCommandParentBehavior;
}

export interface UiSlashCommandCatalog {
  readonly version: string;
  readonly commands: readonly UiSlashCommandSpec[];
}

export interface UiParsedSlashCommandInput {
  readonly raw: string;
  readonly commandLine: string;
  readonly segments: readonly string[];
  readonly rawArgs: string;
  readonly argv: readonly string[];
  readonly body: string;
  readonly tokenSpans: readonly UiSlashTokenSpan[];
}

export interface UiSlashTokenSpan {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

export interface UiSlashCommandInvocation {
  readonly clientInvocationId: string;
  readonly commandId: string;
  readonly path: readonly string[];
  readonly raw: string;
  readonly rawArgs: string;
  readonly argv: readonly string[];
  readonly body?: string;
  readonly sessionId?: string;
  readonly surface: UiSlashCommandSurface;
  readonly argumentMode?: UiSlashCommandArgumentMode;
}

export type UiSlashCommandOutput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "markdown"; readonly markdown: string }
  | {
      readonly kind: "data";
      readonly subject: string;
      readonly data: Record<string, unknown>;
    };

export interface UiSlashCommandAction {
  readonly kind: string;
  readonly label?: string;
  readonly data?: Record<string, unknown>;
}

export interface UiSlashCommandError {
  readonly code: string;
  readonly message: string;
  readonly recoverable?: boolean;
  readonly details?: unknown;
}

export type UiSlashCommandResolveErrorCode =
  | "NOT_A_COMMAND"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_NOT_AVAILABLE_ON_SURFACE"
  | "AMBIGUOUS_COMMAND";

export interface UiSlashCommandResolveError {
  readonly code: UiSlashCommandResolveErrorCode;
  readonly message: string;
}

export interface UiSlashCommandResolveOptions {
  readonly surface?: UiSlashCommandSurface;
}

export interface UiSlashCommandResolved {
  readonly ok: true;
  readonly command: UiSlashCommandSpec;
  readonly path: readonly string[];
  readonly usedAlias?: readonly string[];
  readonly raw: string;
  readonly rawArgs: string;
  readonly argv: readonly string[];
  readonly body: string;
}

export type UiSlashCommandResolveResult =
  | UiSlashCommandResolved
  | { readonly ok: false; readonly error: UiSlashCommandResolveError };

export type UiCommandSurface = UiSlashCommandSurface;
export type UiCommandArgumentMode = UiSlashCommandArgumentMode;
export type UiCommandSource = UiSlashCommandSource;
export type UiCommandParentBehavior = UiSlashCommandParentBehavior;
export type UiCommandSpec = UiSlashCommandSpec;
export type UiCommandCatalog = UiSlashCommandCatalog;
export type UiParsedSlashInput = UiParsedSlashCommandInput;
export type UiCommandInvocation = UiSlashCommandInvocation;
export type UiCommandOutput = UiSlashCommandOutput;
export type UiCommandAction = UiSlashCommandAction;
export type UiCommandError = UiSlashCommandError;
export type UiCommandResolveErrorCode = UiSlashCommandResolveErrorCode;
export type UiCommandResolveError = UiSlashCommandResolveError;
export type UiCommandResolveOptions = UiSlashCommandResolveOptions;
export type UiCommandResolved = UiSlashCommandResolved;
export type UiCommandResolveResult = UiSlashCommandResolveResult;
