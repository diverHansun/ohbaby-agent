import { normalizeOptionName, optionValue } from "../utils/path-strings.js";

export interface ShellExecutionTarget {
  readonly executedScript?: string;
  readonly inlineEval?: boolean;
  readonly interpreter?: string;
  readonly scriptTokenIndex?: number;
}

const PYTHON_OPTION_VALUE_FLAGS = new Set([
  "-W",
  "-X",
  "--check-hash-based-pycs",
]);
const NODE_OPTION_VALUE_FLAGS = new Set([
  "--diagnostic-dir",
  "--experimental-loader",
  "--heap-prof-dir",
  "--icu-data-dir",
  "--import",
  "--loader",
  "--prof-process",
  "--require",
  "-r",
]);
const DENO_SCRIPT_SUBCOMMANDS = new Set([
  "bench",
  "bundle",
  "compile",
  "run",
  "test",
]);
const BUN_SCRIPT_SUBCOMMANDS = new Set(["run", "test"]);
const SHELL_OPTION_VALUE_FLAGS = new Set(["--init-file", "--rcfile"]);
const POWERSHELL_INLINE_OPTIONS = new Set([
  "-command",
  "-encodedcommand",
  "-encodedarguments",
]);

function normalizeExecutableName(token: string): string {
  const normalized = token.replace(/\\/gu, "/");
  const slashIndex = normalized.lastIndexOf("/");
  return normalized
    .slice(slashIndex + 1)
    .toLowerCase()
    .replace(/\.exe$/u, "");
}

function isPython(executable: string): boolean {
  return executable === "py" || /^python(?:\d+(?:\.\d+)?)?$/u.test(executable);
}

function hasInlineValue(token: string): boolean {
  return optionValue(token) !== null;
}

function isPythonVersionFlag(token: string): boolean {
  return /^-\d+(?:\.\d+)?$/u.test(token);
}

function nextScriptAfterOptions(
  tokens: readonly string[],
  startIndex: number,
  input: {
    readonly inlineOptions?: ReadonlySet<string>;
    readonly moduleOptions?: ReadonlySet<string>;
    readonly valueOptions?: ReadonlySet<string>;
    readonly skipPythonVersionFlags?: boolean;
  } = {},
): ShellExecutionTarget {
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    const optionName = normalizeOptionName(token);

    if (token === "--") {
      const script = tokens[index + 1];
      return script
        ? { executedScript: script, scriptTokenIndex: index + 1 }
        : {};
    }

    if (input.skipPythonVersionFlags && isPythonVersionFlag(token)) {
      continue;
    }

    if (!token.startsWith("-")) {
      return { executedScript: token, scriptTokenIndex: index };
    }

    if (input.inlineOptions?.has(optionName)) {
      return { inlineEval: true };
    }
    if (input.moduleOptions?.has(optionName)) {
      return {};
    }

    if (hasInlineValue(token)) {
      continue;
    }
    if (input.valueOptions?.has(optionName)) {
      index += 1;
    }
  }

  return {};
}

function resolvePython(tokens: readonly string[]): ShellExecutionTarget {
  const result = nextScriptAfterOptions(tokens, 1, {
    inlineOptions: new Set(["-c"]),
    moduleOptions: new Set(["-m"]),
    skipPythonVersionFlags: true,
    valueOptions: PYTHON_OPTION_VALUE_FLAGS,
  });
  return { ...result, interpreter: normalizeExecutableName(tokens[0]) };
}

function resolveNode(tokens: readonly string[]): ShellExecutionTarget {
  const result = nextScriptAfterOptions(tokens, 1, {
    inlineOptions: new Set(["-e", "--eval", "-p", "--print"]),
    valueOptions: NODE_OPTION_VALUE_FLAGS,
  });
  return { ...result, interpreter: normalizeExecutableName(tokens[0]) };
}

function resolveSimpleInterpreter(
  tokens: readonly string[],
): ShellExecutionTarget {
  const result = nextScriptAfterOptions(tokens, 1, {
    inlineOptions: new Set(["-e", "-r"]),
  });
  return { ...result, interpreter: normalizeExecutableName(tokens[0]) };
}

function resolveDeno(tokens: readonly string[]): ShellExecutionTarget {
  const executable = normalizeExecutableName(tokens[0]);
  const subcommand = tokens[1]?.toLowerCase();
  if (subcommand === "eval") {
    return { inlineEval: true, interpreter: executable };
  }
  if (!subcommand || !DENO_SCRIPT_SUBCOMMANDS.has(subcommand)) {
    return { interpreter: executable };
  }
  const result = nextScriptAfterOptions(tokens, 2);
  return { ...result, interpreter: executable };
}

function resolveBun(tokens: readonly string[]): ShellExecutionTarget {
  const executable = normalizeExecutableName(tokens[0]);
  const subcommand = tokens[1]?.toLowerCase();
  if (subcommand === "eval") {
    return { inlineEval: true, interpreter: executable };
  }
  if (subcommand && BUN_SCRIPT_SUBCOMMANDS.has(subcommand)) {
    const result = nextScriptAfterOptions(tokens, 2);
    return { ...result, interpreter: executable };
  }
  const result = nextScriptAfterOptions(tokens, 1, {
    inlineOptions: new Set(["-e", "--eval"]),
  });
  return { ...result, interpreter: executable };
}

function resolvePowerShell(tokens: readonly string[]): ShellExecutionTarget {
  const executable = normalizeExecutableName(tokens[0]);
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const optionName = normalizeOptionName(token);
    if (POWERSHELL_INLINE_OPTIONS.has(optionName)) {
      return { inlineEval: true, interpreter: executable };
    }
    if (optionName === "-file") {
      const inlineValue = optionValue(token);
      const script = inlineValue ?? tokens[index + 1];
      return script
        ? {
            executedScript: script,
            interpreter: executable,
            scriptTokenIndex: inlineValue === null ? index + 1 : index,
          }
        : { interpreter: executable };
    }
  }

  return { interpreter: executable };
}

function shellOptionIsInlineEval(token: string): boolean {
  const optionName = normalizeOptionName(token);
  if (optionName === "-c" || optionName === "/c" || optionName === "-command") {
    return true;
  }
  return /^-[^-].*c/u.test(token);
}

function resolveShell(tokens: readonly string[]): ShellExecutionTarget {
  const executable = normalizeExecutableName(tokens[0]);
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const optionName = normalizeOptionName(token);

    if (token === "--") {
      const script = tokens[index + 1];
      return script
        ? {
            executedScript: script,
            interpreter: executable,
            scriptTokenIndex: index + 1,
          }
        : { interpreter: executable };
    }
    if (shellOptionIsInlineEval(token)) {
      return { inlineEval: true, interpreter: executable };
    }
    if (token.startsWith("-") || token.startsWith("/")) {
      if (!hasInlineValue(token) && SHELL_OPTION_VALUE_FLAGS.has(optionName)) {
        index += 1;
      }
      continue;
    }

    return {
      executedScript: token,
      interpreter: executable,
      scriptTokenIndex: index,
    };
  }

  return { interpreter: executable };
}

export function resolveShellExecutionTarget(
  tokens: readonly string[],
): ShellExecutionTarget {
  if (tokens.length === 0) {
    return {};
  }

  const executable = normalizeExecutableName(tokens[0]);
  if (isPython(executable)) {
    return resolvePython(tokens);
  }
  if (executable === "node" || executable === "nodejs") {
    return resolveNode(tokens);
  }
  if (executable === "deno") {
    return resolveDeno(tokens);
  }
  if (executable === "bun") {
    return resolveBun(tokens);
  }
  if (executable === "ruby" || executable === "perl" || executable === "php") {
    return resolveSimpleInterpreter(tokens);
  }
  if (executable === "pwsh" || executable === "powershell") {
    return resolvePowerShell(tokens);
  }
  if (
    executable === "bash" ||
    executable === "cmd" ||
    executable === "iex" ||
    executable === "invoke-expression" ||
    executable === "sh" ||
    executable === "zsh"
  ) {
    return resolveShell(tokens);
  }

  return {};
}
