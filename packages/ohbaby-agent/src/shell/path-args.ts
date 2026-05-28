import type { CommandDetail } from "../utils/index.js";
import {
  candidatePathFromToken,
  normalizeOptionName,
  optionValue,
  stripRedirectionPrefix,
} from "../utils/path-strings.js";
import { gitGlobalPathArgs } from "./git-args.js";
import { resolveShellExecutionTarget } from "./interpreters.js";

const PATH_ARGUMENT_COMMANDS = new Set([
  "cat",
  "copy",
  "cp",
  "del",
  "dir",
  "erase",
  "head",
  "less",
  "ls",
  "md",
  "mkdir",
  "more",
  "move",
  "mv",
  "rm",
  "rmdir",
  "tail",
  "tee",
  "touch",
  "type",
  "xcopy",
]);
const POWERSHELL_PATH_COMMANDS = new Set([
  "add-content",
  "clear-content",
  "copy-item",
  "get-childitem",
  "get-content",
  "move-item",
  "new-item",
  "rd",
  "remove-item",
  "set-content",
]);
const SEARCH_COMMANDS = new Set(["grep", "rg", "select-string"]);
const DOWNLOAD_COMMANDS = new Set([
  "curl",
  "wget",
  "iwr",
  "irm",
  "invoke-restmethod",
  "invoke-webrequest",
]);
const PATH_VALUE_OPTIONS = new Set([
  "-c",
  "-f",
  "-literalpath",
  "-o",
  "-outfile",
  "-path",
  "--output",
  "--output-document",
]);
const SCRIPT_PATH_VALUE_OPTIONS = new Set([
  "--cache-dir",
  "--config",
  "--env-file",
  "--file",
  "--input",
  "--input-dir",
  "--output",
  "--output-dir",
  "--out",
  "--path",
]);
const SEARCH_PATTERN_OPTIONS = new Set([
  "-e",
  "-pattern",
  "--pattern",
  "--regexp",
]);
const NON_PATH_OPTIONS_WITH_VALUE = new Set([
  "-aftercontext",
  "-beforecontext",
  "-context",
  "-encoding",
  "-exclude",
  "-filter",
  "-g",
  "-include",
  "-inputobject",
  "-itemtype",
  "-m",
  "-n",
  "-totalcount",
  "--after-context",
  "--before-context",
  "--context",
  "--encoding",
  "--exclude",
  "--glob",
  "--include",
  "--max-count",
]);
const PATH_PREFIX_PATTERN =
  /^(?:\.{1,2}(?:[\\/]|$)|~(?:[\\/]|$)|[\\/]|[A-Za-z]:[\\/])/u;
const PATH_SUFFIX_PATTERN = /^[\w.-]+(?:[\\/][\w .-]+)+$/u;
const FIND_LEADING_OPTIONS = new Set(["-H", "-L", "-P"]);
const DIRECT_EXECUTABLE_PREFIX_PATTERN =
  /^(?:\.{1,2}[\\/]|~[\\/]|[\\/]|[A-Za-z]:[\\/])/u;

export interface ShellPathFacts {
  readonly executedScript?: string;
  readonly inlineEval?: boolean;
  readonly interpreter?: string;
  readonly pathArgs: readonly string[];
}

function normalizeRoot(root: string): string {
  return root.toLowerCase().replace(/\.exe$/u, "");
}

function isOption(token: string): boolean {
  return token.startsWith("-") || /^\/[A-Za-z](?::|$)/u.test(token);
}

function isStandaloneRedirection(token: string): boolean {
  return /^(?:\d+|&)?[<>]{1,2}$/u.test(token);
}

function addCandidate(paths: Set<string>, token: string | undefined): void {
  if (!token) {
    return;
  }
  const candidate = candidatePathFromToken(token);
  if (candidate) {
    paths.add(candidate);
  }
}

function looksLikePathArg(token: string): boolean {
  const candidate = candidatePathFromToken(token);
  if (!candidate) {
    return false;
  }
  return (
    candidate === "." ||
    candidate === ".." ||
    PATH_PREFIX_PATTERN.test(candidate) ||
    PATH_SUFFIX_PATTERN.test(candidate)
  );
}

function addRedirectionTargets(
  paths: Set<string>,
  args: readonly string[],
): Set<number> {
  const consumed = new Set<number>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (isStandaloneRedirection(token) && args[index + 1]) {
      addCandidate(paths, args[index + 1]);
      consumed.add(index);
      consumed.add(index + 1);
      index += 1;
      continue;
    }
    const stripped = stripRedirectionPrefix(token);
    if (stripped !== token && stripped.length > 0) {
      addCandidate(paths, token);
      consumed.add(index);
    }
  }
  return consumed;
}

function consumeOptionValue(
  paths: Set<string>,
  args: readonly string[],
  index: number,
  pathOptions = PATH_VALUE_OPTIONS,
): number {
  const token = args[index];
  const optionName = normalizeOptionName(token);
  const inlineValue = optionValue(token);
  if (inlineValue !== null) {
    if (pathOptions.has(optionName)) {
      addCandidate(paths, inlineValue);
    }
    return index;
  }
  if (pathOptions.has(optionName) && args[index + 1]) {
    addCandidate(paths, args[index + 1]);
    return index + 1;
  }
  if (NON_PATH_OPTIONS_WITH_VALUE.has(optionName) && args[index + 1]) {
    return index + 1;
  }

  return index;
}

function addAllPositionalPaths(
  paths: Set<string>,
  args: readonly string[],
  consumed: ReadonlySet<number>,
): void {
  for (let index = 0; index < args.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }
    const token = args[index];
    if (isOption(token)) {
      index = consumeOptionValue(paths, args, index);
      continue;
    }
    addCandidate(paths, token);
  }
}

function looksLikeDirectExecutableRoot(root: string): boolean {
  return DIRECT_EXECUTABLE_PREFIX_PATTERN.test(root);
}

function addScriptArgumentPaths(
  paths: Set<string>,
  args: readonly string[],
  consumed: ReadonlySet<number>,
  startIndex: number,
): void {
  for (let index = startIndex; index < args.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }

    const token = args[index];
    if (isOption(token)) {
      const optionName = normalizeOptionName(token);
      const inlineValue = optionValue(token);
      if (SCRIPT_PATH_VALUE_OPTIONS.has(optionName)) {
        if (inlineValue !== null) {
          addCandidate(paths, inlineValue);
        } else {
          addCandidate(paths, args[index + 1]);
          index += 1;
        }
        continue;
      }
      if (NON_PATH_OPTIONS_WITH_VALUE.has(optionName) && inlineValue === null) {
        index += 1;
      }
      continue;
    }

    if (looksLikePathArg(token)) {
      addCandidate(paths, token);
    }
  }
}

function addSearchCommandPaths(
  paths: Set<string>,
  args: readonly string[],
  consumed: ReadonlySet<number>,
  root: string,
): void {
  let hasPattern = root === "rg" && args.includes("--files");
  for (let index = 0; index < args.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }
    const token = args[index];
    if (isOption(token)) {
      const optionName = normalizeOptionName(token);
      const inlineValue = optionValue(token);
      if (PATH_VALUE_OPTIONS.has(optionName)) {
        if (inlineValue !== null) {
          addCandidate(paths, inlineValue);
        } else {
          addCandidate(paths, args[index + 1]);
          index += 1;
        }
        continue;
      }
      if (SEARCH_PATTERN_OPTIONS.has(optionName)) {
        hasPattern = true;
        if (inlineValue === null) {
          index += 1;
        }
        continue;
      }
      index = consumeOptionValue(paths, args, index);
      continue;
    }
    if (!hasPattern) {
      hasPattern = true;
      continue;
    }
    addCandidate(paths, token);
  }
}

function addModeThenPathArgs(
  paths: Set<string>,
  args: readonly string[],
  consumed: ReadonlySet<number>,
): void {
  let skippedMode = false;
  for (let index = 0; index < args.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }
    const token = args[index];
    if (isOption(token)) {
      index = consumeOptionValue(paths, args, index);
      continue;
    }
    if (!skippedMode) {
      skippedMode = true;
      continue;
    }
    addCandidate(paths, token);
  }
}

function addDownloadOutputPaths(
  paths: Set<string>,
  args: readonly string[],
  consumed: ReadonlySet<number>,
): void {
  for (let index = 0; index < args.length; index += 1) {
    if (consumed.has(index) || !isOption(args[index])) {
      continue;
    }
    index = consumeOptionValue(paths, args, index);
  }
}

function addFindPaths(
  paths: Set<string>,
  args: readonly string[],
  consumed: ReadonlySet<number>,
): void {
  for (let index = 0; index < args.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }
    const token = args[index];
    if (FIND_LEADING_OPTIONS.has(token)) {
      continue;
    }
    if (token === "!" || token === "(" || isOption(token)) {
      break;
    }
    addCandidate(paths, token);
  }
}

export function extractShellPathFacts(detail: CommandDetail): ShellPathFacts {
  const root = normalizeRoot(detail.root);
  const args = detail.tokens.slice(detail.rootIndex + 1);
  const paths = new Set<string>();
  const redirectionConsumed = addRedirectionTargets(paths, args);
  const consumed = redirectionConsumed;
  const execution = resolveShellExecutionTarget(
    detail.tokens.slice(detail.rootIndex),
  );
  const scriptArgIndex =
    execution.scriptTokenIndex === undefined
      ? undefined
      : execution.scriptTokenIndex - 1;

  if (execution.executedScript) {
    const startIndex =
      scriptArgIndex === undefined ? 0 : Math.max(scriptArgIndex + 1, 0);
    addScriptArgumentPaths(paths, args, consumed, startIndex);
  } else if (looksLikeDirectExecutableRoot(detail.root)) {
    addScriptArgumentPaths(paths, args, consumed, 0);
  } else if (SEARCH_COMMANDS.has(root)) {
    addSearchCommandPaths(paths, args, consumed, root);
  } else if (root === "chmod" || root === "chown") {
    addModeThenPathArgs(paths, args, consumed);
  } else if (root === "find") {
    addFindPaths(paths, args, consumed);
  } else if (DOWNLOAD_COMMANDS.has(root)) {
    addDownloadOutputPaths(paths, args, consumed);
  } else if (
    PATH_ARGUMENT_COMMANDS.has(root) ||
    POWERSHELL_PATH_COMMANDS.has(root)
  ) {
    addAllPositionalPaths(paths, args, consumed);
  } else if (root === "git") {
    for (const gitPathArg of gitGlobalPathArgs(args)) {
      addCandidate(paths, gitPathArg);
    }
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "-C") {
        addCandidate(paths, args[index + 1]);
        index += 1;
      } else if (!isOption(args[index]) && looksLikePathArg(args[index])) {
        addCandidate(paths, args[index]);
      }
    }
  }

  return {
    executedScript:
      execution.executedScript ??
      (looksLikeDirectExecutableRoot(detail.root) ? detail.root : undefined),
    inlineEval: execution.inlineEval,
    interpreter: execution.interpreter,
    pathArgs: [...paths],
  };
}

export function extractShellPathArgs(detail: CommandDetail): readonly string[] {
  const facts = extractShellPathFacts(detail);
  const paths = new Set<string>();
  if (facts.executedScript) {
    addCandidate(paths, facts.executedScript);
  }
  for (const pathArg of facts.pathArgs) {
    addCandidate(paths, pathArg);
  }

  return [...paths];
}
