import type { CommandDetail, ParsedCommand } from "../utils/index.js";
import { gitSubcommand } from "./git-args.js";

export type ShellCommandClass = "readonly" | "mutating" | "dangerous";

const READONLY_ROOTS = new Set([
  "cat",
  "dir",
  "find",
  "get-childitem",
  "get-content",
  "grep",
  "head",
  "less",
  "ls",
  "more",
  "pwd",
  "rg",
  "tail",
  "type",
]);
const MUTATING_ROOTS = new Set([
  "add-content",
  "copy",
  "copy-item",
  "cp",
  "del",
  "erase",
  "md",
  "mkdir",
  "move",
  "move-item",
  "mv",
  "new-item",
  "rd",
  "remove-item",
  "rmdir",
  "set-content",
  "tee",
  "touch",
  "xcopy",
]);
const DANGEROUS_ROOTS = new Set([
  "chown",
  "dd",
  "format",
  "halt",
  "poweroff",
  "reboot",
  "shutdown",
  "sudo",
]);
const SHELL_EXEC_ROOTS = new Set([
  "bash",
  "cmd",
  "iex",
  "invoke-expression",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);
const SHELL_COMMAND_CLASS_RANK: Record<ShellCommandClass, number> = {
  readonly: 0,
  mutating: 1,
  dangerous: 2,
};

function normalizeRoot(root: string): string {
  return root.toLowerCase().replace(/\.exe$/u, "");
}

function commandArgs(detail: CommandDetail): readonly string[] {
  return detail.tokens.slice(detail.rootIndex + 1);
}

function maxShellCommandClass(
  left: ShellCommandClass,
  right: ShellCommandClass,
): ShellCommandClass {
  return SHELL_COMMAND_CLASS_RANK[right] > SHELL_COMMAND_CLASS_RANK[left]
    ? right
    : left;
}

function hasWrapper(detail: CommandDetail, wrapper: string): boolean {
  return detail.tokens
    .slice(0, detail.rootIndex)
    .map(normalizeRoot)
    .includes(wrapper);
}

function hasRedirection(detail: CommandDetail): boolean {
  return detail.tokens.some((token) => /^[&\d]*>{1,2}/u.test(token));
}

function hasUnixRecursiveForce(args: readonly string[]): boolean {
  const flags = args.filter((arg) => arg.startsWith("-")).join("");
  return /r|R/u.test(flags) && flags.includes("f");
}

function gitCommandClass(args: readonly string[]): ShellCommandClass {
  const subcommand = gitSubcommand(args);
  return subcommand === "status" ||
    subcommand === "log" ||
    subcommand === "diff"
    ? "readonly"
    : "mutating";
}

function chmodCommandClass(args: readonly string[]): ShellCommandClass {
  return args.some((arg) => arg.replace(/^0/u, "") === "777")
    ? "dangerous"
    : "mutating";
}

function rmCommandClass(args: readonly string[]): ShellCommandClass {
  return hasUnixRecursiveForce(args) ? "dangerous" : "mutating";
}

function detailCommandClass(detail: CommandDetail): ShellCommandClass {
  if (hasWrapper(detail, "sudo")) {
    return "dangerous";
  }

  const root = normalizeRoot(detail.root);
  const args = commandArgs(detail);
  if (DANGEROUS_ROOTS.has(root)) {
    return "dangerous";
  }
  if (root === "rm") {
    return rmCommandClass(args);
  }
  if (root === "chmod") {
    return chmodCommandClass(args);
  }
  if (root === "git") {
    return gitCommandClass(args);
  }
  if (root === "npm" || root === "pnpm" || root === "yarn") {
    return "mutating";
  }
  if (SHELL_EXEC_ROOTS.has(root) || root === "xargs") {
    return "mutating";
  }
  if (root === "echo" || root === "write-host") {
    return hasRedirection(detail) ? "mutating" : "readonly";
  }
  if (MUTATING_ROOTS.has(root)) {
    return "mutating";
  }
  if (READONLY_ROOTS.has(root)) {
    return "readonly";
  }
  return "mutating";
}

export function classifyShellCommand(parsed: ParsedCommand): ShellCommandClass {
  if (parsed.hasError || parsed.details.length === 0) {
    return "mutating";
  }

  let result: ShellCommandClass = "readonly";
  for (const detail of parsed.details) {
    result = maxShellCommandClass(result, detailCommandClass(detail));
  }
  return result;
}
