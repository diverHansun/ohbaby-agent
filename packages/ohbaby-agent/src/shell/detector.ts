import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BLACKLISTED_SHELLS } from "./constants.js";

export interface ShellDetectionInput {
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly existsSync?: (candidate: string) => boolean;
  readonly platform?: NodeJS.Platform;
  readonly which?: (command: string) => string | undefined;
}

function shellName(shellPath: string, platform: NodeJS.Platform): string {
  const basename =
    platform === "win32"
      ? path.win32.basename(shellPath, ".exe")
      : path.basename(shellPath);

  return basename.toLowerCase();
}

function defaultWhich(command: string): string | undefined {
  try {
    return execFileSync(process.platform === "win32" ? "where" : "which", [
      command,
    ])
      .toString("utf8")
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

function defaultShell(platform: NodeJS.Platform, env: ShellDetectionInput["env"]): string {
  if (platform === "win32") {
    return env?.COMSPEC ?? "cmd.exe";
  }
  if (platform === "darwin") {
    return "/bin/zsh";
  }

  return "/bin/bash";
}

export function isBlacklistedShell(
  shellPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return BLACKLISTED_SHELLS.has(shellName(shellPath, platform));
}

export function deriveGitBashPath(gitPath: string): string {
  const normalized = path.win32.normalize(gitPath);
  const lower = normalized.toLowerCase();
  if (lower.endsWith("\\cmd\\git.exe")) {
    return path.win32.join(path.win32.dirname(normalized), "..", "bin", "bash.exe");
  }

  return path.win32.join(path.win32.dirname(normalized), "bash.exe");
}

export function resolvePreferredShell(input: ShellDetectionInput = {}): string {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const shell = env.SHELL;
  if (shell) {
    return shell;
  }

  return defaultShell(platform, env);
}

export function resolveAcceptableShell(input: ShellDetectionInput = {}): string {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const shell = env.SHELL;
  if (shell && !isBlacklistedShell(shell, platform)) {
    return shell;
  }
  const existsSync = input.existsSync ?? fs.existsSync;
  const which = input.which ?? defaultWhich;
  if (platform === "win32") {
    const gitPath = which("git");
    if (gitPath) {
      const bashPath = deriveGitBashPath(gitPath);
      if (existsSync(bashPath)) {
        return bashPath;
      }
    }
  }

  return defaultShell(platform, env);
}
