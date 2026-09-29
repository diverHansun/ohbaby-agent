import type { UiPromptReceipt } from "../prompt.js";

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
  readonly clientRequestId?: string;
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

/** Handler completion, independent of transport delivery and subsequent prompt execution. */
export type UiCommandCompletion = {
  readonly commandRunId: string;
  readonly clientInvocationId: string;
  readonly sessionId?: string;
  /** Number of output-bearing result events. */
  readonly outputCount: number;
  /** Number of result and failure events, including pure actions; excludes started. */
  readonly eventCount: number;
  readonly promptReceipt?: UiPromptReceipt;
} & (
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: UiSlashCommandError }
);

/** Validate receipts at transport boundaries, including older daemons returning void. */
export function isUiCommandCompletion(
  value: unknown,
): value is UiCommandCompletion {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<UiCommandCompletion>;
  if (
    candidate.sessionId !== undefined &&
    (typeof candidate.sessionId !== "string" ||
      candidate.sessionId.length === 0)
  )
    return false;
  if (candidate.promptReceipt !== undefined) {
    const rawReceipt = (value as { promptReceipt: unknown }).promptReceipt;
    if (typeof rawReceipt !== "object" || rawReceipt === null) return false;
    const receipt = rawReceipt as Partial<UiPromptReceipt>;
    if (
      ![
        receipt.promptId,
        receipt.clientRequestId,
        receipt.userMessageId,
        receipt.sessionId,
      ].every((id) => typeof id === "string" && id.length > 0) ||
      typeof receipt.createdAt !== "string" ||
      !Number.isFinite(Date.parse(receipt.createdAt)) ||
      ![
        "steered",
        "queued",
        "retained",
        "starting",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "interrupted",
      ].includes(receipt.status ?? "")
    )
      return false;
  }
  return (
    typeof candidate.commandRunId === "string" &&
    candidate.commandRunId.length > 0 &&
    typeof candidate.clientInvocationId === "string" &&
    candidate.clientInvocationId.length > 0 &&
    typeof candidate.outputCount === "number" &&
    Number.isSafeInteger(candidate.outputCount) &&
    candidate.outputCount >= 0 &&
    typeof candidate.eventCount === "number" &&
    Number.isSafeInteger(candidate.eventCount) &&
    candidate.eventCount >= candidate.outputCount &&
    (candidate.status === "completed" ||
      (candidate.status === "failed" &&
        typeof candidate.error?.code === "string" &&
        typeof candidate.error.message === "string"))
  );
}
