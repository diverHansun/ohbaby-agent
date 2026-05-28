import os from "node:os";
import path from "node:path";
import type { DenylistReason } from "./types.js";

const SENSITIVE_DIR_REASONS = new Map<string, DenylistReason>([
  [".aws", "aws-credentials"],
  [".gnupg", "gnupg-dir"],
  [".ssh", "ssh-key-dir"],
]);
const SHELL_RC_FILES = new Set([
  ".bash_profile",
  ".bashrc",
  ".profile",
  ".zprofile",
  ".zshrc",
  "microsoft.powershell_profile.ps1",
]);
const SAFE_ENV_TEMPLATE_FILES = new Set([
  ".env.defaults",
  ".env.example",
  ".env.sample",
  ".env.template",
]);

function pathSegments(inputPath: string): readonly string[] {
  return path
    .resolve(inputPath)
    .split(/[\\/]+/u)
    .map((segment) => segment.toLowerCase())
    .filter(Boolean);
}

function isEnvFile(basename: string): boolean {
  return (
    basename === ".env" ||
    (basename.startsWith(".env.") && !SAFE_ENV_TEMPLATE_FILES.has(basename))
  );
}

function isPrivateKeyFile(basename: string): boolean {
  return basename.endsWith(".pem") || basename.endsWith(".key");
}

export function classifyDenylistedPath(
  absolutePath: string,
): DenylistReason | undefined {
  const home = os.homedir();
  if (!pathSegments(absolutePath).includes(path.basename(home).toLowerCase())) {
    return undefined;
  }
  for (const segment of pathSegments(absolutePath)) {
    const reason = SENSITIVE_DIR_REASONS.get(segment);
    if (reason) {
      return reason;
    }
  }

  return undefined;
}

export function classifySensitivePath(
  absolutePath: string,
): DenylistReason | undefined {
  const basename = path.basename(absolutePath).toLowerCase();
  if (isEnvFile(basename)) {
    return "env-file";
  }
  if (isPrivateKeyFile(basename)) {
    return "private-key";
  }
  if (SHELL_RC_FILES.has(basename)) {
    return "shell-rc";
  }

  return undefined;
}
