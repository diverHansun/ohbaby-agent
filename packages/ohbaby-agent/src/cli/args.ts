export type CliPermissionMode = "plan" | "auto";

export type CliPermissionLevel = "default" | "full-access";

export interface CliPermissionOptions {
  readonly permissionMode?: CliPermissionMode;
  readonly permissionLevel?: CliPermissionLevel;
}

export type CliArgs =
  | ({ readonly mode: "interactive" } & CliPermissionOptions)
  | ({ readonly mode: "help" } & CliPermissionOptions)
  | ({ readonly mode: "version" } & CliPermissionOptions)
  | ({
      readonly mode: "prompt";
      readonly prompt: string;
    } & CliPermissionOptions);

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  let mode: CliArgs["mode"] = "interactive";
  let prompt: string | undefined;
  let permissionMode: CliPermissionMode | undefined;
  let permissionLevel: CliPermissionLevel | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--help" || current === "-h") {
      mode = "help";
      continue;
    }
    if (current === "--version" || current === "-v") {
      mode = "version";
      continue;
    }
    if (current === "--prompt" || current === "-p") {
      const value = args[index + 1];
      if (!value) {
        throw new CliArgumentError(`${current} requires a value`);
      }
      mode = "prompt";
      prompt = value;
      index += 1;
      continue;
    }
    if (current.startsWith("--prompt=")) {
      const value = current.slice("--prompt=".length);
      if (value.length === 0) {
        throw new CliArgumentError("--prompt requires a value");
      }
      mode = "prompt";
      prompt = value;
      continue;
    }
    if (current === "--mode") {
      const value = args[index + 1];
      permissionMode = parsePermissionMode(value, current);
      index += 1;
      continue;
    }
    if (current.startsWith("--mode=")) {
      permissionMode = parsePermissionMode(
        current.slice("--mode=".length),
        "--mode",
      );
      continue;
    }
    if (current === "--permission") {
      const value = args[index + 1];
      permissionLevel = parsePermissionLevel(value, current);
      index += 1;
      continue;
    }
    if (current.startsWith("--permission=")) {
      permissionLevel = parsePermissionLevel(
        current.slice("--permission=".length),
        "--permission",
      );
      continue;
    }

    throw new CliArgumentError(`Unknown argument: ${current}`);
  }

  const permissionOptions = {
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(permissionLevel === undefined ? {} : { permissionLevel }),
  };

  if (mode === "prompt") {
    if (!prompt) {
      throw new CliArgumentError("--prompt requires a value");
    }
    return { mode, prompt, ...permissionOptions };
  }

  return { mode, ...permissionOptions };
}

function parsePermissionMode(
  value: string | undefined,
  flag: string,
): CliPermissionMode {
  if (value !== "plan" && value !== "auto") {
    throw new CliArgumentError(`${flag} requires plan or auto`);
  }
  return value;
}

function parsePermissionLevel(
  value: string | undefined,
  flag: string,
): CliPermissionLevel {
  if (value !== "default" && value !== "full-access") {
    throw new CliArgumentError(`${flag} requires default or full-access`);
  }
  return value;
}

export function renderHelp(): string {
  return [
    "Usage: ohbaby [options]",
    "",
    "Options:",
    "  -p, --prompt <text>                 run one non-interactive prompt",
    "      --mode <plan|auto>              set initial permission mode",
    "      --permission <default|full-access> set initial permission level",
    "  -h, --help                          show help",
    "  -v, --version                       show version",
    "",
  ].join("\n");
}
