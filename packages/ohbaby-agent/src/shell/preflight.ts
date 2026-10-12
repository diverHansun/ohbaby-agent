import path from "node:path";
import { canonicalizePathTarget } from "../utils/path-canonicalize.js";
import { resolveSandboxPathArg } from "../sandbox/paths.js";
import type {
  ShellAnalysisResult,
  ShellCommandAnalysis,
} from "./analysis/types.js";

export type ShellKind = "bash" | "zsh" | "sh" | "cmd" | "powershell";
export interface ShellPreflightInput {
  readonly command: string;
  readonly cwd: string;
  readonly shellAnalysis: ShellAnalysisResult;
}
export interface ShellPreflightResult {
  readonly cdTargets: readonly string[];
  readonly resolvedPaths: readonly string[];
}
export class ShellPreflightError extends Error {
  readonly code = "PERMISSION_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "ShellPreflightError";
  }
}
const DOWNLOADS = new Set([
  "curl",
  "wget",
  "iwr",
  "irm",
  "invoke-restmethod",
  "invoke-webrequest",
]);
const SHELLS = new Set([
  "bash",
  "cmd",
  "iex",
  "invoke-expression",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
  "source",
  ".",
]);
export function detectShellKind(shellPath: string): ShellKind {
  const name = path.win32
    .basename(shellPath)
    .toLowerCase()
    .replace(/\.exe$/u, "");
  if (name === "cmd" || name === "command.com") return "cmd";
  if (name === "powershell" || name === "pwsh") return "powershell";
  if (name === "zsh" || name === "sh") return name;
  return "bash";
}
export function shellArgs(
  shellPath: string,
  command: string,
): readonly string[] {
  const kind = detectShellKind(shellPath);
  if (kind === "cmd") return ["/d", "/s", "/c", command];
  if (kind === "powershell")
    return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
  return ["-lc", command];
}
function rootTarget(value: string): boolean {
  return (
    ["/", "/*", "~", "~/", "\\"].includes(value) ||
    /^[A-Za-z]:[\\/]*$/u.test(value)
  );
}
function reject(message: string): never {
  throw new ShellPreflightError(message);
}
function assertPolicy(command: ShellCommandAnalysis, kind: ShellKind): void {
  const root = path.win32
    .basename(command.root)
    .toLowerCase()
    .replace(/\.exe$/u, "");
  const args = command.tokens.slice(1);
  const flags = args.filter((arg) => arg.startsWith("-")).join("");
  const lower = args.map((arg) => arg.toLowerCase());
  const destructive =
    (root === "rm" && /r|R/u.test(flags) && flags.includes("f")) ||
    (kind === "powershell" &&
      ["remove-item", "rm", "del", "erase"].includes(root) &&
      lower.includes("-recurse") &&
      lower.includes("-force"));
  if (destructive && args.some(rootTarget))
    reject("Command is blacklisted: destructive removal of a root path.");
  if (["format", "shutdown", "reboot", "halt", "poweroff"].includes(root))
    reject(`Command is blacklisted: ${root}.`);
}
/** Literal facts with an unknown cwd can still protect absolute paths. */
export function resolveAnalyzedPath(
  command: ShellCommandAnalysis,
  target: string,
  cwd: string,
  kind: ShellKind,
): string | undefined {
  if (
    command.cwd === undefined &&
    !path.isAbsolute(target) &&
    !path.win32.isAbsolute(target)
  )
    return undefined;
  const workdir =
    command.cwd === undefined
      ? cwd
      : (resolveSandboxPathArg({
          arg: command.cwd,
          workdir: cwd,
          shellKind: kind,
          literal: true,
        }) ?? cwd);
  return resolveSandboxPathArg({
    arg: target,
    workdir,
    shellKind: kind,
    literal: true,
  });
}
export async function preflightShellCommand(
  input: ShellPreflightInput,
): Promise<ShellPreflightResult> {
  const analysis = input.shellAnalysis;
  // cmd has no grammar. Retain only direct, unambiguous existing policy patterns.
  if (analysis.shellKind === "cmd") {
    if (
      /^\s*(?:rmdir|rd|del|erase)\s+(?=[^&|\n]*\/s\b)(?=[^&|\n]*\/q\b)[^&|\n]*(?:[A-Za-z]:[\\/]?|[\\/])\s*$/iu.test(
        input.command,
      ) ||
      /^\s*(?:format|shutdown|reboot|halt|poweroff)(?:\s|$)/iu.test(
        input.command,
      )
    )
      reject("Command is blacklisted: destructive system command.");
  }
  const pipelines = new Set<number>();
  for (const command of analysis.commands) {
    assertPolicy(command, analysis.shellKind);
    if (command.pipelineId !== undefined && DOWNLOADS.has(command.root))
      pipelines.add(command.pipelineId);
    if (
      command.pipelineId !== undefined &&
      pipelines.has(command.pipelineId) &&
      SHELLS.has(command.root)
    )
      reject(
        "Command pipes downloaded content into a shell; use a reviewed file and explicit execution instead.",
      );
  }
  const cdTargets = new Set<string>();
  const resolvedPaths = new Set<string>();
  const downloaded = new Set<string>();
  for (const command of analysis.commands) {
    const resolve = async (target: string): Promise<string | undefined> => {
      const candidate = resolveAnalyzedPath(
        command,
        target,
        input.cwd,
        analysis.shellKind,
      );
      return candidate === undefined
        ? undefined
        : canonicalizePathTarget(candidate);
    };
    // Only execution facts consume a downloaded file, never its output/path argument.
    if (command.executedScript) {
      const script = await resolve(command.executedScript);
      if (script && downloaded.has(script))
        reject(
          "Command downloads a file and executes it in the same shell request.",
        );
      if (script) resolvedPaths.add(script);
    }
    for (const target of command.pathArgs) {
      const resolved = await resolve(target);
      if (!resolved) continue;
      if (target === command.cdTarget) cdTargets.add(resolved);
      else resolvedPaths.add(resolved);
    }
    for (const target of command.downloadTargets ?? []) {
      const resolved = await resolve(target);
      if (resolved) downloaded.add(resolved);
    }
  }
  return { cdTargets: [...cdTargets], resolvedPaths: [...resolvedPaths] };
}
