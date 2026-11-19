import { existsSync } from "node:fs";
import { join } from "node:path";
import spawn from "cross-spawn";

export function npmCommand(prefix: string): string {
  const windows = process.platform === "win32";
  const preferred = windows
    ? join(prefix, "npm.cmd")
    : join(prefix, "bin", "npm");
  return existsSync(preferred) ? preferred : windows ? "npm.cmd" : "npm";
}

export function installedCliCommand(prefix: string): string {
  return process.platform === "win32"
    ? join(prefix, "ohbaby.cmd")
    : join(prefix, "bin", "ohbaby");
}

export function runInstallerCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly capture?: boolean;
  } = {},
): Promise<{ readonly status: string; readonly output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: options.env,
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
      windowsHide: true,
    });
    let output = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ status: String(code ?? signal), output: output.trim() });
    });
  });
}
