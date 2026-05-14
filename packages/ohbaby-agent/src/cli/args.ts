export type CliArgs =
  | { readonly mode: "interactive" }
  | { readonly mode: "help" }
  | { readonly mode: "version" }
  | { readonly mode: "prompt"; readonly prompt: string };

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  if (args.length === 0) {
    return { mode: "interactive" };
  }

  const [first, second] = args;
  if (first === "--help" || first === "-h") {
    return { mode: "help" };
  }
  if (first === "--version" || first === "-v") {
    return { mode: "version" };
  }
  if (first === "--prompt" || first === "-p") {
    if (!second) {
      throw new CliArgumentError(`${first} requires a value`);
    }
    return { mode: "prompt", prompt: second };
  }
  if (first.startsWith("--prompt=")) {
    const prompt = first.slice("--prompt=".length);
    if (prompt.length === 0) {
      throw new CliArgumentError("--prompt requires a value");
    }
    return { mode: "prompt", prompt };
  }

  throw new CliArgumentError(`Unknown argument: ${first}`);
}

export function renderHelp(): string {
  return [
    "Usage: ohbaby [options]",
    "",
    "Options:",
    "  -p, --prompt <text>  run one non-interactive prompt",
    "  -h, --help           show help",
    "  -v, --version        show version",
    "",
  ].join("\n");
}
