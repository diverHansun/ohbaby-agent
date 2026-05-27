import os from "node:os";
import path from "node:path";
import type { ShellKind } from "../shell/index.js";

const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;
const COMMAND_SUBSTITUTION_PATTERN = /`|\$\(|<\(|>\(/u;
const BRACED_HOME_PATTERN = /^\$\{HOME\}(?:[\\/](.*))?$/iu;
const HOME_PATTERN = /^\$HOME(?:[\\/](.*))?$/iu;
const POWERSHELL_HOME_PATTERN = /^\$env:USERPROFILE(?:[\\/](.*))?$/iu;
const CMD_HOME_PATTERN = /^%USERPROFILE%(?:[\\/](.*))?$/iu;

function stripMatchingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function msysPathToWindowsPath(target: string): string | undefined {
  const match = /^\/([A-Za-z])(?:\/(.*))?$/u.exec(target);
  if (!match || process.platform !== "win32") {
    return undefined;
  }
  const drive = match[1].toUpperCase();
  const rest = match[2] ? match[2].replace(/\//gu, "\\") : "";
  return `${drive}:\\${rest}`;
}

function resolveHomePath(match: RegExpExecArray): string {
  return match[1] ? path.resolve(os.homedir(), match[1]) : os.homedir();
}

function expandKnownHomeVariable(target: string): string | undefined {
  const braced = BRACED_HOME_PATTERN.exec(target);
  if (braced) {
    return resolveHomePath(braced);
  }
  const home = HOME_PATTERN.exec(target);
  if (home) {
    return resolveHomePath(home);
  }
  const powershellHome = POWERSHELL_HOME_PATTERN.exec(target);
  if (powershellHome) {
    return resolveHomePath(powershellHome);
  }
  const cmdHome = CMD_HOME_PATTERN.exec(target);
  if (cmdHome) {
    return resolveHomePath(cmdHome);
  }

  return undefined;
}

export function resolveSandboxPathArg(input: {
  readonly arg: string;
  readonly shellKind: ShellKind;
  readonly workdir: string;
}): string | undefined {
  const target = stripMatchingQuotes(input.arg.trim());
  if (!target || URL_PATTERN.test(target) || COMMAND_SUBSTITUTION_PATTERN.test(target)) {
    return undefined;
  }
  if (target === "~") {
    return os.homedir();
  }
  if (target.startsWith("~/") || target.startsWith("~\\")) {
    return path.resolve(os.homedir(), target.slice(2));
  }

  const expanded = expandKnownHomeVariable(target);
  if (expanded) {
    return expanded;
  }

  const msysPath =
    input.shellKind === "bash" ? msysPathToWindowsPath(target) : undefined;
  if (msysPath) {
    return path.resolve(msysPath);
  }
  if (path.isAbsolute(target)) {
    return path.resolve(target);
  }
  return path.resolve(input.workdir, target);
}
