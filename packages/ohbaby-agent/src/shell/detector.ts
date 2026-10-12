import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BLACKLISTED_SHELLS } from "./constants.js";

const SUPPORTED_SHELLS = new Set([
  "bash",
  "cmd",
  "command",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);
export interface ShellDetectionInput {
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly existsSync?: (candidate: string) => boolean;
  readonly platform?: NodeJS.Platform;
  readonly which?: (command: string) => string | undefined;
}
function shellName(shellPath: string, platform: NodeJS.Platform): string {
  return (
    platform === "win32"
      ? path.win32.basename(shellPath)
      : path.basename(shellPath)
  )
    .toLowerCase()
    .replace(/\.exe$/u, "");
}
function defaultWhich(command: string): string | undefined {
  try {
    return execFileSync(
      process.platform === "win32" ? "where" : "which",
      [command],
      { windowsHide: true },
    )
      .toString("utf8")
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}
export function isBlacklistedShell(
  shellPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return BLACKLISTED_SHELLS.has(shellName(shellPath, platform));
}
export function resolvePreferredShell(input: ShellDetectionInput = {}): string {
  const shell = (input.env ?? process.env).SHELL;
  return shell && shell.length > 0 ? shell : resolveAcceptableShell(input);
}
export function resolveAcceptableShell(
  input: ShellDetectionInput = {},
): string {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const exists = input.existsSync ?? fs.existsSync;
  const which = input.which ?? defaultWhich;
  const shell = env.SHELL;
  // MSYS login paths are inherited preferences, not native Windows executables.
  const msysPreference = platform === "win32" && shell?.startsWith("/");
  if (
    shell &&
    !msysPreference &&
    SUPPORTED_SHELLS.has(shellName(shell, platform))
  ) {
    const bare = !shell.includes("/") && !shell.includes("\\");
    const resolved = bare ? which(shell) : exists(shell) ? shell : undefined;
    if (!resolved) throw new Error(`Configured shell is unavailable: ${shell}`);
    if (
      platform === "win32" &&
      /\\(?:system32|syswow64|sysnative)\\(?:bash|wsl)\.exe$/iu.test(resolved)
    )
      throw new Error(
        `WSL launchers are unsupported: ${resolved}. Configure a native Git Bash executable path.`,
      );
    return resolved;
  }
  if (platform === "win32") {
    const pwsh = which("pwsh.exe");
    if (pwsh) return pwsh;
    const powershell = which("powershell.exe");
    if (powershell) return powershell;
    const systemPowerShell = path.win32.join(
      env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (exists(systemPowerShell)) return systemPowerShell;
    throw new Error(
      "Shell unavailable: neither pwsh.exe nor Windows PowerShell was found.",
    );
  }
  if (platform === "darwin") {
    if (exists("/bin/zsh")) return "/bin/zsh";
    throw new Error("Shell unavailable: /bin/zsh was not found.");
  }
  const bash = which("bash") ?? (exists("/bin/bash") ? "/bin/bash" : undefined);
  if (bash) return bash;
  if (exists("/bin/sh")) return "/bin/sh";
  throw new Error("Shell unavailable: neither bash nor /bin/sh was found.");
}
