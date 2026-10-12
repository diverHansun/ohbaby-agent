import type { ShellCommandFacts } from "./command-classifier.js";
import { gitGlobalPathArgs, normalizeGitArgs } from "./git-args.js";
import { resolveShellExecutionTarget } from "./interpreters.js";

const PATH_COMMANDS = new Set([
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
const DIRECTORIES = new Set([
  "cd",
  "chdir",
  "push-location",
  "pushd",
  "set-location",
  "sl",
]);
const DOWNLOADS = new Set([
  "curl",
  "wget",
  "iwr",
  "irm",
  "invoke-restmethod",
  "invoke-webrequest",
]);
const SCRIPT_PATH_OPTIONS = new Set([
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
const SEARCH_VALUE_OPTIONS = new Set([
  "-g",
  "-m",
  "-A",
  "-B",
  "-C",
  "--glob",
  "--max-count",
  "--after-context",
  "--before-context",
  "--context",
  "--encoding",
  "--include",
  "--exclude",
]);
const POWERSHELL_VALUE_OPTIONS = new Set([
  "-totalcount",
  "-tail",
  "-encoding",
  "-filter",
  "-include",
  "-exclude",
  "-inputobject",
  "-itemtype",
]);
const PATH_OPTIONS = new Set(["-path", "-literalpath"]);
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;
export interface ShellPathFacts {
  readonly executedScript?: string;
  readonly inlineEval?: boolean;
  readonly interpreter?: string;
  readonly pathArgs: readonly string[];
  readonly downloadTargets?: readonly string[];
}
function looksLikePath(value: string): boolean {
  return (
    /^(?:\.{1,2}(?:[\\/]|$)|~(?:[\\/]|$)|[\\/]|[A-Za-z]:[\\/])/u.test(value) ||
    /^[\w.-]+[\\/]/u.test(value)
  );
}
/** Command-specific argv semantics only. Shell structure and redirection come from the AST. */
export function extractShellPathFacts(
  command: ShellCommandFacts,
): ShellPathFacts {
  const root = command.root;
  const args = command.tokens.slice(1);
  const execution = resolveShellExecutionTarget(command.tokens);
  const paths = new Set<string>();
  const downloads: string[] = [];
  const add = (value: string | undefined): void => {
    if (value && !URL_PATTERN.test(value)) paths.add(value);
  };
  const directScript = looksLikePath(command.tokens[0] ?? "")
    ? command.tokens[0]
    : undefined;
  const scripted = execution.executedScript ?? directScript;
  if (root === "git") {
    for (const value of gitGlobalPathArgs(args)) add(value);
    for (const value of normalizeGitArgs(args))
      if (looksLikePath(value)) add(value);
  } else if (DOWNLOADS.has(root)) {
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i];
      const name = token.split("=", 1)[0].toLowerCase();
      if (
        (root === "wget" ? token === "-O" : token === "-o") ||
        ["--output", "--output-document", "-outfile"].includes(name)
      ) {
        const value = token.includes("=")
          ? token.slice(token.indexOf("=") + 1)
          : args[++i];
        if (value) {
          add(value);
          downloads.push(value);
        }
      }
    }
  } else if (root === "find") {
    for (const value of args) {
      if (["-H", "-L", "-P"].includes(value)) continue;
      if (value === "!" || value === "(" || value.startsWith("-")) break;
      add(value);
    }
  } else {
    const search = ["grep", "rg", "select-string"].includes(root);
    let hasPattern = root === "rg" && args.includes("--files");
    let skippedMode = false;
    let positional = false;
    const scriptStart = execution.scriptTokenIndex ?? 0;
    for (let i = scripted ? scriptStart : 0; i < args.length; i += 1) {
      const token = args[i];
      if (!token) continue;
      if (token === "--") {
        positional = true;
        continue;
      }
      const name = token.split("=", 1)[0].toLowerCase();
      const inline = token.includes("=")
        ? token.slice(token.indexOf("=") + 1)
        : undefined;
      if (!positional && token.startsWith("-")) {
        if (
          PATH_OPTIONS.has(name) ||
          (scripted && SCRIPT_PATH_OPTIONS.has(name)) ||
          (search && ["-f", "--file"].includes(name))
        ) {
          add(inline ?? args[++i]);
          if (DIRECTORIES.has(root)) break;
        } else if (search && SEARCH_PATTERN_OPTIONS.has(name)) {
          hasPattern = true;
          if (inline === undefined) i += 1;
        } else if (
          (search && SEARCH_VALUE_OPTIONS.has(token.split("=", 1)[0])) ||
          POWERSHELL_VALUE_OPTIONS.has(name) ||
          (["head", "tail"].includes(root) &&
            ["-n", "-c", "--lines", "--bytes"].includes(name))
        ) {
          if (inline === undefined) i += 1;
        }
        continue;
      }
      if (DIRECTORIES.has(root)) {
        if (token !== "-") add(token);
        break;
      }
      if (search && !hasPattern) {
        hasPattern = true;
        continue;
      }
      if ((root === "chmod" || root === "chown") && !skippedMode) {
        skippedMode = true;
        continue;
      }
      if (
        PATH_COMMANDS.has(root) ||
        search ||
        root === "chmod" ||
        root === "chown" ||
        (scripted && looksLikePath(token))
      )
        add(token);
    }
  }
  return {
    executedScript: execution.executedScript ?? directScript,
    inlineEval: execution.inlineEval,
    interpreter: execution.interpreter,
    pathArgs: [...paths],
    downloadTargets: downloads,
  };
}
