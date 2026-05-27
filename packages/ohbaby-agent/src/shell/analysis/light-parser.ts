import type { CommandDetail } from "../../utils/index.js";
import { parseCommand } from "../../utils/index.js";
import { classifyShellCommand } from "../command-classifier.js";
import type { ShellKind } from "../preflight.js";
import { computeShellArityKey } from "./arity.js";
import type { ShellAnalysisResult, ShellCommandAnalysis } from "./types.js";

const PATH_ARGUMENT_COMMANDS = new Set([
  "cat",
  "chmod",
  "chown",
  "copy",
  "cp",
  "del",
  "dir",
  "erase",
  "find",
  "grep",
  "head",
  "less",
  "ls",
  "md",
  "mkdir",
  "more",
  "move",
  "mv",
  "add-content",
  "clear-content",
  "copy-item",
  "get-childitem",
  "get-content",
  "move-item",
  "new-item",
  "rd",
  "remove-item",
  "rm",
  "rmdir",
  "rg",
  "set-content",
  "tail",
  "tee",
  "touch",
  "type",
  "xcopy",
]);
const DOWNLOAD_COMMANDS = new Set([
  "curl",
  "wget",
  "iwr",
  "irm",
  "invoke-restmethod",
  "invoke-webrequest",
]);
const SHELL_EXEC_COMMANDS = new Set([
  "bash",
  "cmd",
  "iex",
  "invoke-expression",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;
const DYNAMIC_PATTERN =
  /`|\$\(|\$\{|<\(|>\(|%[A-Za-z_][A-Za-z0-9_]*%|\$env:|\$[A-Za-z_][A-Za-z0-9_]*/iu;

function normalizeRoot(root: string): string {
  return root.toLowerCase().replace(/\.exe$/u, "");
}

function stripMatchingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function stripRedirectionPrefix(token: string): string {
  return token.replace(/^(?:\d+|&)?[<>]+/u, "");
}

function optionValue(token: string): string | null {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex > 0) {
    return token.slice(equalsIndex + 1);
  }
  const colonIndex = token.indexOf(":");
  if (token.startsWith("/") && colonIndex > 1) {
    return token.slice(colonIndex + 1);
  }

  return null;
}

function candidatePathFromToken(token: string): string | null {
  const normalized = stripMatchingQuotes(stripRedirectionPrefix(token));
  const value = optionValue(normalized) ?? normalized;
  if (!value || URL_PATTERN.test(value)) {
    return null;
  }
  return value;
}

function rootAcceptsPathArguments(root: string): boolean {
  return (
    PATH_ARGUMENT_COMMANDS.has(root) ||
    DOWNLOAD_COMMANDS.has(root) ||
    SHELL_EXEC_COMMANDS.has(root)
  );
}

function pathArgs(detail: CommandDetail, root: string): readonly string[] {
  const candidates = new Set<string>();
  for (const existing of detail.paths) {
    candidates.add(existing);
  }
  if (!rootAcceptsPathArguments(root)) {
    return [...candidates];
  }

  const args = detail.tokens.slice(detail.rootIndex + 1);
  for (const arg of args) {
    if (arg.startsWith("-")) {
      const value = optionValue(arg);
      if (value) {
        candidates.add(value);
      }
      continue;
    }
    const candidate = candidatePathFromToken(arg);
    if (candidate) {
      candidates.add(candidate);
    }
  }

  return [...candidates];
}

function commandDanger(source: string): ShellCommandAnalysis["danger"] {
  return classifyShellCommand(parseCommand(source));
}

function analyzeDetail(detail: CommandDetail): ShellCommandAnalysis {
  const tokens = detail.tokens.slice(detail.rootIndex);
  const root = normalizeRoot(detail.root);
  return {
    arityKey: computeShellArityKey(tokens),
    danger: commandDanger(detail.text),
    hasDynamic: DYNAMIC_PATTERN.test(detail.text),
    pathArgs: pathArgs(detail, root),
    root,
    source: detail.text,
    tokens,
  };
}

export function analyzeShellCommandLight(
  command: string,
  shellKind: ShellKind,
): Promise<ShellAnalysisResult> {
  const parsed = parseCommand(command);
  return Promise.resolve({
    commands: parsed.details.map(analyzeDetail),
    parseError: parsed.hasError
      ? "Shell command contains unsupported or incomplete syntax; analysis used lightweight fallback facts."
      : undefined,
    shellKind,
  });
}
