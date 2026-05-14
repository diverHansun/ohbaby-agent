export type UiCommandSurface =
  | "tui"
  | "stdout"
  | "headless"
  | "remote"
  | (string & {});

export type UiCommandArgumentMode = "raw" | "argv" | "structured";

export type UiCommandSource = "builtin" | "user" | "mcp" | "skill" | "plugin";

export type UiCommandParentBehavior = "interaction" | "help" | "none";

export interface UiCommandSpec {
  readonly id: string;
  readonly path: readonly string[];
  readonly aliases?: readonly (readonly string[])[];
  readonly category: string;
  readonly description: string;
  readonly argsHint?: string;
  readonly argumentMode: UiCommandArgumentMode;
  readonly source: UiCommandSource;
  readonly surfaces: readonly UiCommandSurface[];
  readonly parentBehavior?: UiCommandParentBehavior;
}

export interface UiCommandCatalog {
  readonly version: string;
  readonly commands: readonly UiCommandSpec[];
}

export interface UiParsedSlashInput {
  readonly raw: string;
  readonly commandLine: string;
  readonly path: readonly string[];
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

export interface UiCommandInvocation {
  readonly clientInvocationId: string;
  readonly commandId: string;
  readonly path: readonly string[];
  readonly raw: string;
  readonly rawArgs: string;
  readonly argv: readonly string[];
  readonly body?: string;
  readonly sessionId?: string;
  readonly surface: UiCommandSurface;
  readonly argumentMode?: UiCommandArgumentMode;
}

export type UiCommandOutput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "markdown"; readonly markdown: string }
  | {
      readonly kind: "data";
      readonly subject: string;
      readonly data: Record<string, unknown>;
    };

export interface UiCommandAction {
  readonly kind: string;
  readonly label?: string;
  readonly data?: Record<string, unknown>;
}

export interface UiCommandError {
  readonly code: string;
  readonly message: string;
  readonly recoverable?: boolean;
  readonly details?: unknown;
}

export type UiCommandResolveErrorCode =
  | "NOT_A_COMMAND"
  | "COMMAND_NOT_FOUND"
  | "AMBIGUOUS_COMMAND";

export interface UiCommandResolveError {
  readonly code: UiCommandResolveErrorCode;
  readonly message: string;
}

export interface UiCommandResolved {
  readonly ok: true;
  readonly command: UiCommandSpec;
  readonly path: readonly string[];
  readonly usedAlias?: readonly string[];
  readonly raw: string;
  readonly rawArgs: string;
  readonly argv: readonly string[];
  readonly body: string;
}

export type UiCommandResolveResult =
  | UiCommandResolved
  | { readonly ok: false; readonly error: UiCommandResolveError };
