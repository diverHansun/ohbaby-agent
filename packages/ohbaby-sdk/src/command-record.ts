export type UiCommandMethod =
  | "submitPromptAccepted"
  | "editQueuedPrompt"
  | "cancelQueuedPrompt"
  | "acquirePromptEditLease"
  | "renewPromptEditLease"
  | "releasePromptEditLease"
  | "compactSession"
  | "archiveSession"
  | "connectModel"
  | "setSearchApiKey"
  | "setPermission"
  | "executeCommand"
  | "respondPermission"
  | "respondInteraction"
  | "abortRun";

export type UiCommandEntryPoint =
  | "agent-host"
  | "server-rest"
  | "server-rpc";

export interface UiCommandCorrelation {
  readonly transportRequestId?: string;
  readonly clientId?: string;
  readonly clientRequestId?: string;
  readonly clientInvocationId?: string;
  readonly sessionId?: string;
  readonly promptId?: string;
  readonly runId?: string;
  readonly commandRunId?: string;
  readonly permissionRequestId?: string;
  readonly interactionId?: string;
}

export type UiCommandDetails = Readonly<
  Record<string, boolean | number | string>
>;

export interface UiCommandErrorSummary {
  readonly code?: string;
  readonly message: string;
  readonly name: string;
}

interface UiCommandRecordBase {
  readonly operationId: string;
  readonly method: UiCommandMethod;
  readonly occurredAt: string;
  readonly entryPoint: UiCommandEntryPoint;
  readonly correlation: UiCommandCorrelation;
  readonly details?: UiCommandDetails;
}

export type UiCommandRecord =
  | (UiCommandRecordBase & {
      readonly phase: "started";
    })
  | (UiCommandRecordBase & {
      readonly phase: "completed";
      readonly outcome:
        | { readonly kind: "returned" }
        | {
            readonly kind: "threw";
            readonly error: UiCommandErrorSummary;
          };
    });

export interface UiCommandRecorder {
  record(entry: UiCommandRecord): void;
}

export interface UiCommandObservationDiagnostic {
  readonly error: unknown;
  readonly stage:
    | "clock"
    | "correlation"
    | "details"
    | "operation-id"
    | "recorder";
}

export interface ExecuteRecordedUiCommandOptions<Result> {
  readonly method: UiCommandMethod;
  readonly entryPoint: UiCommandEntryPoint;
  readonly recorder: UiCommandRecorder;
  readonly execute: () => Promise<Result> | Result;
  readonly correlation?: UiCommandCorrelation;
  readonly correlateResult?: (result: Result) => UiCommandCorrelation;
  readonly createDetails?: () => UiCommandDetails | undefined;
  readonly createOperationId?: () => string;
  readonly now?: () => Date;
  readonly onDiagnostic?: (diagnostic: UiCommandObservationDiagnostic) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(args: readonly unknown[], index: number): Record<string, unknown> {
  const value = args[index];
  return isRecord(value) ? value : {};
}

function stringAt(args: readonly unknown[], index: number): string | undefined {
  const value = args[index];
  return typeof value === "string" ? value : undefined;
}

export function buildUiCommandDetails(
  method: UiCommandMethod,
  args: readonly unknown[],
): UiCommandDetails | undefined {
  switch (method) {
    case "submitPromptAccepted": {
      const text = stringAt(args, 0) ?? "";
      const options = objectAt(args, 1);
      return {
        hasClientRequestId: typeof options.clientRequestId === "string",
        hasExplicitSessionId: typeof options.sessionId === "string",
        textLength: text.length,
      };
    }
    case "editQueuedPrompt": {
      const input = objectAt(args, 0);
      return {
        textLength: typeof input.text === "string" ? input.text.length : 0,
      };
    }
    case "compactSession": {
      const input = objectAt(args, 0);
      return {
        force: input.force === true,
        hasExplicitSessionId: typeof input.sessionId === "string",
      };
    }
    case "connectModel": {
      const input = objectAt(args, 0);
      const interfaceProvider = input.interfaceProvider;
      return {
        hasApiKey: typeof input.apiKey === "string",
        hasExplicitContextWindow:
          typeof input.contextWindowTokens === "number",
        ...(interfaceProvider === "anthropic" ||
        interfaceProvider === "openai-compatible"
          ? { interfaceProvider }
          : {}),
      };
    }
    case "setSearchApiKey": {
      const input = objectAt(args, 0);
      return { hasApiKey: typeof input.apiKey === "string" };
    }
    case "setPermission": {
      const input = objectAt(args, 0);
      return {
        hasLevel: typeof input.level === "string",
        hasMode: typeof input.mode === "string",
      };
    }
    case "executeCommand": {
      const input = objectAt(args, 0);
      return {
        argumentCount: Array.isArray(input.argv) ? input.argv.length : 0,
        hasSessionId: typeof input.sessionId === "string",
      };
    }
    case "respondInteraction": {
      const response = objectAt(args, 1);
      return response.kind === "accepted" || response.kind === "cancelled"
        ? { responseKind: response.kind }
        : undefined;
    }
    case "abortRun":
      return { hasExplicitRunId: typeof args[0] === "string" };
    case "acquirePromptEditLease":
    case "archiveSession":
    case "cancelQueuedPrompt":
    case "releasePromptEditLease":
    case "renewPromptEditLease":
    case "respondPermission":
      return undefined;
  }
}

export function summarizeUiCommandError(
  error: unknown,
): UiCommandErrorSummary {
  const record = isRecord(error) ? error : {};
  const rawName = record.name;
  const rawCode = record.code;
  const name =
    typeof rawName === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(rawName)
      ? rawName
      : "Error";
  const code =
    typeof rawCode === "string" && /^[A-Z0-9_.-]{1,64}$/.test(rawCode)
      ? rawCode
      : undefined;
  return {
    ...(code === undefined ? {} : { code }),
    message: "Command execution failed",
    name,
  };
}

export async function executeRecordedUiCommand<Result>(
  options: ExecuteRecordedUiCommandOptions<Result>,
): Promise<Result> {
  let diagnosed = false;
  const diagnose = (
    stage: UiCommandObservationDiagnostic["stage"],
    error: unknown,
  ): void => {
    if (diagnosed) {
      return;
    }
    diagnosed = true;
    try {
      options.onDiagnostic?.({ error, stage });
    } catch {
      // Observation failures must never change the command result.
    }
  };
  const observe = <Value>(
    stage: UiCommandObservationDiagnostic["stage"],
    create: () => Value,
  ): Value | undefined => {
    try {
      return create();
    } catch (error) {
      diagnose(stage, error);
      return undefined;
    }
  };

  const operationId = observe(
    "operation-id",
    options.createOperationId ??
      ((): string => globalThis.crypto.randomUUID()),
  );
  const details =
    options.createDetails === undefined
      ? undefined
      : observe("details", options.createDetails);
  const baseCorrelation = options.correlation ?? {};
  const now = options.now ?? ((): Date => new Date());

  const record = (
    create: (occurredAt: string, operationId: string) => UiCommandRecord,
  ): void => {
    if (operationId === undefined) {
      return;
    }
    const occurredAt = observe("clock", () => now().toISOString());
    if (occurredAt === undefined) {
      return;
    }
    const entry = create(occurredAt, operationId);
    observe("recorder", (): void => {
      options.recorder.record(entry);
    });
  };

  record((occurredAt, currentOperationId) => ({
    correlation: baseCorrelation,
    ...(details === undefined ? {} : { details }),
    entryPoint: options.entryPoint,
    method: options.method,
    occurredAt,
    operationId: currentOperationId,
    phase: "started",
  }));

  try {
    const result = await options.execute();
    const resultCorrelation =
      options.correlateResult === undefined
        ? undefined
        : observe("correlation", () => options.correlateResult?.(result));
    record((occurredAt, currentOperationId) => ({
      correlation: { ...baseCorrelation, ...resultCorrelation },
      ...(details === undefined ? {} : { details }),
      entryPoint: options.entryPoint,
      method: options.method,
      occurredAt,
      operationId: currentOperationId,
      outcome: { kind: "returned" },
      phase: "completed",
    }));
    return result;
  } catch (error) {
    record((occurredAt, currentOperationId) => ({
      correlation: baseCorrelation,
      ...(details === undefined ? {} : { details }),
      entryPoint: options.entryPoint,
      method: options.method,
      occurredAt,
      operationId: currentOperationId,
      outcome: { error: summarizeUiCommandError(error), kind: "threw" },
      phase: "completed",
    }));
    throw error;
  }
}
