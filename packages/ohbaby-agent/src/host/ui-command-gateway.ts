import {
  executeRecordedUiCommand,
  submitPromptAndWait as composeSubmitPromptAndWait,
} from "ohbaby-sdk";
import type {
  UiBackendClient,
  UiCommandCorrelation,
  UiCommandEntryPoint,
  UiCommandMethod,
  UiCommandObservationDiagnostic,
  UiCommandRecorder,
  UiPromptCompletion,
  UiSubmitPromptAndWaitOptions,
} from "ohbaby-sdk";
import type { UiPromptQueueExecutionPort } from "../adapters/ui-inprocess.js";

export interface UiCommandGatewayOptions {
  readonly entryPoint: UiCommandEntryPoint;
  readonly recorder: UiCommandRecorder;
  readonly correlation?: UiCommandCorrelation;
  readonly createOperationId?: () => string;
  readonly now?: () => Date;
  readonly onDiagnostic?: (diagnostic: UiCommandObservationDiagnostic) => void;
}

export type RecordedUiBackendClient = UiBackendClient &
  Partial<UiPromptQueueExecutionPort>;

const RECORDED_METHODS = new Set<UiCommandMethod>([
  "submitPromptAccepted",
  "editQueuedPrompt",
  "cancelQueuedPrompt",
  "acquirePromptEditLease",
  "renewPromptEditLease",
  "releasePromptEditLease",
  "compactSession",
  "archiveSession",
  "connectModel",
  "setSearchApiKey",
  "setPermission",
  "executeCommand",
  "respondPermission",
  "respondInteraction",
  "abortRun",
]);

const TRUSTED_QUEUE_METHODS = new Map<PropertyKey, UiCommandMethod>([
  ["acquirePromptEditLeaseForOwner", "acquirePromptEditLease"],
  ["renewPromptEditLeaseForOwner", "renewPromptEditLease"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(
  args: readonly unknown[],
  index: number,
): Record<string, unknown> {
  const value = args[index];
  return isRecord(value) ? value : {};
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function inputCorrelation(
  method: UiCommandMethod,
  args: readonly unknown[],
): UiCommandCorrelation {
  const input = objectAt(args, 0);
  switch (method) {
    case "submitPromptAccepted": {
      const options = objectAt(args, 1);
      return {
        ...(stringField(options, "clientRequestId") === undefined
          ? {}
          : { clientRequestId: stringField(options, "clientRequestId") }),
        ...(stringField(options, "sessionId") === undefined
          ? {}
          : { sessionId: stringField(options, "sessionId") }),
      };
    }
    case "editQueuedPrompt":
    case "cancelQueuedPrompt":
    case "acquirePromptEditLease":
    case "renewPromptEditLease":
    case "releasePromptEditLease":
      return {
        ...(stringField(input, "promptId") === undefined
          ? {}
          : { promptId: stringField(input, "promptId") }),
      };
    case "compactSession":
    case "archiveSession":
      return {
        ...(stringField(input, "sessionId") === undefined
          ? {}
          : { sessionId: stringField(input, "sessionId") }),
      };
    case "executeCommand":
      return {
        ...(stringField(input, "clientInvocationId") === undefined
          ? {}
          : {
              clientInvocationId: stringField(input, "clientInvocationId"),
            }),
        ...(stringField(input, "sessionId") === undefined
          ? {}
          : { sessionId: stringField(input, "sessionId") }),
      };
    case "respondPermission":
      return typeof args[0] === "string"
        ? { permissionRequestId: args[0] }
        : {};
    case "respondInteraction":
      return typeof args[0] === "string" ? { interactionId: args[0] } : {};
    case "abortRun":
      return typeof args[0] === "string" ? { runId: args[0] } : {};
    case "connectModel":
    case "setPermission":
    case "setSearchApiKey":
      return {};
  }
}

function returnedCorrelation(result: unknown): UiCommandCorrelation {
  if (!isRecord(result)) {
    return {};
  }
  const prompt = isRecord(result.prompt) ? result.prompt : result;
  return {
    ...(stringField(prompt, "clientRequestId") === undefined
      ? {}
      : { clientRequestId: stringField(prompt, "clientRequestId") }),
    ...(stringField(prompt, "promptId") === undefined
      ? {}
      : { promptId: stringField(prompt, "promptId") }),
    ...(stringField(prompt, "sessionId") === undefined
      ? {}
      : { sessionId: stringField(prompt, "sessionId") }),
  };
}

export function createUiCommandGateway(
  client: UiBackendClient,
  options: UiCommandGatewayOptions,
): RecordedUiBackendClient {
  const handler: ProxyHandler<UiBackendClient> = {
    get(target, property, receiver): unknown {
      if (property === "submitPromptAndWait") {
        return (
          text: string,
          submitOptions?: UiSubmitPromptAndWaitOptions,
        ): Promise<UiPromptCompletion> =>
          composeSubmitPromptAndWait(gateway, text, submitOptions);
      }
      const trustedMethod = TRUSTED_QUEUE_METHODS.get(property);
      const method =
        trustedMethod ??
        (typeof property === "string" &&
        RECORDED_METHODS.has(property as UiCommandMethod)
          ? (property as UiCommandMethod)
          : undefined);
      const value = Reflect.get(target, property, receiver) as unknown;
      if (method === undefined || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (...args: readonly unknown[]): Promise<unknown> => {
        const trustedOwnerClientId =
          trustedMethod === undefined || typeof args[1] !== "string"
            ? undefined
            : args[1];
        return executeRecordedUiCommand({
          ...(options.createOperationId === undefined
            ? {}
            : { createOperationId: options.createOperationId }),
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.onDiagnostic === undefined
            ? {}
            : { onDiagnostic: options.onDiagnostic }),
          correlateResult: returnedCorrelation,
          correlation: {
            ...options.correlation,
            ...inputCorrelation(method, args),
            ...(trustedOwnerClientId === undefined
              ? {}
              : { clientId: trustedOwnerClientId }),
          },
          args,
          entryPoint: options.entryPoint,
          execute: () => Reflect.apply(value, target, args) as unknown,
          method,
          recorder: options.recorder,
        });
      };
    },
  };
  const gateway: RecordedUiBackendClient = new Proxy(client, handler);
  return gateway;
}
