import type {
  UiCommandAction,
  UiCommandError,
  UiCommandOutput,
  UiConnectModelInput,
} from "ohbaby-sdk";
import type { CommandRunContext, CommandServiceOptions } from "./types.js";

type ConnectArgName =
  | "provider"
  | "baseUrl"
  | "apiKeyEnv"
  | "model"
  | "contextWindowTokens"
  | "maxOutputTokens";

const FLAG_MAP = new Map<string, ConnectArgName>([
  ["--provider", "provider"],
  ["--base-url", "baseUrl"],
  ["--api-key-env", "apiKeyEnv"],
  ["--model", "model"],
  ["--context-window", "contextWindowTokens"],
  ["--max-output-tokens", "maxOutputTokens"],
]);

function dataOutput(
  subject: string,
  data: Record<string, unknown>,
): UiCommandOutput {
  return { kind: "data", subject, data };
}

function action(kind: string, data?: Record<string, unknown>): UiCommandAction {
  return data ? { kind, data } : { kind };
}

function fail(context: CommandRunContext, error: UiCommandError): void {
  context.fail({ recoverable: true, ...error });
}

export function parseConnectArgs(
  argv: readonly string[],
): UiConnectModelInput | UiCommandError {
  const values: Partial<Record<ConnectArgName, string>> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--api-key" || arg.startsWith("--api-key=")) {
      return {
        code: "UNSUPPORTED_SECRET_ARG",
        message:
          "Do not pass --api-key in slash command arguments. Use the TUI ConnectPanel or set the API key environment variable.",
        recoverable: true,
      };
    }

    const equalsIndex = arg.indexOf("=");
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue =
      equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    const name = FLAG_MAP.get(flag);
    if (!name) {
      return {
        code: "INVALID_ARGS",
        message: "Unknown /connect argument",
        recoverable: true,
      };
    }

    let value = inlineValue;
    const nextValue = argv.at(index + 1);
    if (
      value === undefined &&
      nextValue !== undefined &&
      !nextValue.startsWith("--")
    ) {
      value = nextValue;
      index += 1;
    }
    if (value === undefined || value.trim() === "") {
      return {
        code: "INVALID_ARGS",
        message: `Missing value for ${flag}`,
        recoverable: true,
      };
    }
    values[name] = value;
  }

  const required = [
    ["provider", "--provider"],
    ["baseUrl", "--base-url"],
    ["apiKeyEnv", "--api-key-env"],
    ["model", "--model"],
  ] as const;
  const missing = required
    .filter(([name]) => !values[name])
    .map(([, flag]) => flag);
  if (missing.length > 0) {
    return {
      code: "MISSING_ARGS",
      message: `Missing required /connect arguments: ${missing.join(", ")}`,
      recoverable: true,
    };
  }

  const provider = values.provider;
  const baseUrl = values.baseUrl;
  const apiKeyEnv = values.apiKeyEnv;
  const model = values.model;
  if (
    provider === undefined ||
    baseUrl === undefined ||
    apiKeyEnv === undefined ||
    model === undefined
  ) {
    return {
      code: "MISSING_ARGS",
      message: "Missing required /connect arguments",
      recoverable: true,
    };
  }

  const interfaceProvider = inferInterfaceProvider(baseUrl);

  const contextWindowTokens = parsePositiveInteger(
    values.contextWindowTokens,
    "--context-window",
  );
  if (isCommandError(contextWindowTokens)) {
    return contextWindowTokens;
  }

  const maxOutputTokens = parsePositiveInteger(
    values.maxOutputTokens,
    "--max-output-tokens",
  );
  if (isCommandError(maxOutputTokens)) {
    return maxOutputTokens;
  }

  return {
    provider,
    baseUrl,
    apiKeyEnv,
    model,
    interfaceProvider,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

export async function handleConnect(
  options: CommandServiceOptions,
  argv: readonly string[],
  context: CommandRunContext,
): Promise<void> {
  if (!options.connectModel) {
    fail(context, {
      code: "CONNECT_UNAVAILABLE",
      message: "Connect model is not available in this backend",
    });
    return;
  }

  const parsed = parseConnectArgs(argv);
  if (isCommandError(parsed)) {
    fail(context, parsed);
    return;
  }

  try {
    const result = await options.connectModel(parsed);
    context.emitOutput(dataOutput("model.connected", { result }));
    context.emitAction(action("model.connected", { result }));
  } catch (error) {
    fail(context, {
      code: "CONNECT_FAILED",
      message: error instanceof Error ? error.message : "Connect failed",
    });
  }
}

function parsePositiveInteger(
  value: string | undefined,
  flag: string,
): number | undefined | UiCommandError {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      code: "INVALID_ARGS",
      message: `${flag} must be a positive integer`,
      recoverable: true,
    };
  }
  return parsed;
}

function inferInterfaceProvider(
  baseUrl: string,
): UiConnectModelInput["interfaceProvider"] {
  const lower = baseUrl.toLowerCase();
  return lower.includes("anthropic") ||
    lower.includes("/api/anthropic") ||
    lower.endsWith("/anthropic") ||
    lower.includes("/v1/messages")
    ? "anthropic"
    : "openai-compatible";
}

function isCommandError(value: unknown): value is UiCommandError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value
  );
}
