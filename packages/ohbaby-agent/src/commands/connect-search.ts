import type {
  UiCommandAction,
  UiCommandError,
  UiCommandOutput,
  UiSetSearchApiKeyInput,
} from "ohbaby-sdk";
import type { CommandRunContext, CommandServiceOptions } from "./types.js";

type ConnectSearchArgName = "provider" | "apiKeyEnv";

const FLAG_MAP = new Map<string, ConnectSearchArgName>([
  ["--provider", "provider"],
  ["--api-key-env", "apiKeyEnv"],
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

export function parseConnectSearchArgs(
  argv: readonly string[],
): Omit<UiSetSearchApiKeyInput, "apiKey"> | UiCommandError {
  const values: Partial<Record<ConnectSearchArgName, string>> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--api-key" || arg.startsWith("--api-key=")) {
      return {
        code: "UNSUPPORTED_SECRET_ARG",
        message:
          "Do not pass --api-key in slash command arguments. Use the TUI search connection panel or set the API key environment variable.",
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
        message: "Unknown /connect-search argument",
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

  const provider = values.provider?.trim() ?? "tavily";
  if (provider !== "tavily") {
    return {
      code: "INVALID_ARGS",
      message: "Unsupported search provider",
      recoverable: true,
    };
  }

  const apiKeyEnv = values.apiKeyEnv?.trim() ?? "TAVILY_API_KEY";
  return { apiKeyEnv, provider };
}

export async function handleConnectSearch(
  options: CommandServiceOptions,
  argv: readonly string[],
  context: CommandRunContext,
): Promise<void> {
  if (!options.setSearchApiKey) {
    fail(context, {
      code: "CONNECT_SEARCH_UNAVAILABLE",
      message: "Connect search is not available in this backend",
    });
    return;
  }

  const parsed = parseConnectSearchArgs(argv);
  if (isCommandError(parsed)) {
    fail(context, parsed);
    return;
  }

  try {
    const result = await options.setSearchApiKey(parsed);
    context.emitOutput(dataOutput("search.connected", { result }));
    context.emitAction(action("search.connected", { result }));
  } catch (error) {
    fail(context, {
      code: "CONNECT_SEARCH_FAILED",
      message: error instanceof Error ? error.message : "Connect search failed",
    });
  }
}

function isCommandError(value: unknown): value is UiCommandError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value
  );
}
