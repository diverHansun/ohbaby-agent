import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { runInstallerCommand } from "./child-command.js";
import { readSingleLine } from "./text-file.js";
import { containsPath, PATH_END, PATH_START } from "./uninstall-plan.js";
import { isExactVersion } from "../update/version-check.js";

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!missing(error) || path === dirname(path)) throw error;
    return join(await canonicalPath(dirname(path)), parse(path).base);
  }
}

export async function validateUninstallDirectory(
  installDir: string,
  protectedPaths: readonly string[],
): Promise<void> {
  const canonical = await realpath(installDir);
  if (
    canonical === parse(canonical).root ||
    (await Promise.all(protectedPaths.map(canonicalPath))).some(
      (protectedPath) => containsPath(canonical, protectedPath),
    )
  ) {
    throw new Error(
      `Refusing to remove ${installDir} because it contains a protected home or data path.`,
    );
  }
  const current = join(installDir, "current");
  if (
    !(await lstat(current)).isFile() ||
    !(await lstat(join(installDir, "releases"))).isDirectory() ||
    !isExactVersion(readSingleLine(current))
  ) {
    throw new Error(`Could not verify a script installation at ${installDir}.`);
  }
}

export async function acquireUninstallLock(
  installDir: string,
): Promise<() => Promise<void>> {
  const lock = `${installDir}.lock`;
  await mkdir(lock, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Another installation operation owns ${lock}. Check that operation or run the installer to recover an expired lock.`,
      );
    }
    throw error;
  });
  const release = (): Promise<void> =>
    rm(lock, { recursive: true, force: true });
  try {
    await writeFile(join(lock, "pid"), `${String(process.pid)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    try {
      await lstat(`${lock}.reclaim`);
      throw new Error(`Lock recovery is in progress at ${lock}.reclaim.`);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

export function stripInstallerPathBlock(content: string): string {
  return content.replace(
    /^# >>> ohbaby installer >>>\r?\n(?:(?!^# >>> ohbaby installer >>>\r?$)[\s\S])*?^# <<< ohbaby installer <<<(?:\r?\n|$)/gm,
    "",
  );
}

export async function removeShellPathBlock(
  path: string,
  dedicatedFile: boolean,
): Promise<void> {
  let target: string;
  try {
    target = await realpath(path);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  const content = await readFile(target, "utf8");
  if (!content.includes(PATH_START) || !content.includes(PATH_END)) return;
  const remainder = stripInstallerPathBlock(content);
  if (remainder === content) return;
  if (dedicatedFile && remainder.trim() === "" && target === path) {
    await rm(path, { force: true });
    return;
  }
  const temporary = `${target}.ohbaby.${randomUUID()}`;
  try {
    await writeFile(temporary, remainder, {
      flag: "wx",
      mode: (await stat(target)).mode & 0o777,
    });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function removeOwnedLauncher(
  path: string,
  installDir: string,
): Promise<void> {
  try {
    if (!(await lstat(path)).isFile()) return;
    const [, marker, assignment] = (await readFile(path, "utf8")).split(
      /\r?\n/,
    );
    if (!/^# ohbaby-launcher \d+$/.test(marker)) return;
    const shellQuoted = "'" + installDir.replaceAll("'", "'\\''") + "'";
    if (assignment === `OHBABY_INSTALL_DIR=${shellQuoted}`) {
      await rm(path, { force: true });
      return;
    }
    // POSIX installers encode non-ASCII paths to keep the launcher ASCII.
    const octal = Array.from(
      Buffer.from(installDir),
      (byte) => "\\0" + byte.toString(8).padStart(3, "0"),
    ).join("");
    if (assignment === `OHBABY_INSTALL_DIR=$(printf '%b' '${octal}')`) {
      await rm(path, { force: true });
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

const removeUserPath = String.raw`
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($null -eq $key) { exit 0 }
try {
  $before = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($null -eq $before) { exit 0 }
  $target = $env:OHBABY_UNINSTALL_BIN.TrimEnd('\')
  $after = (($before -split ';') | Where-Object {
    [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"')).TrimEnd('\') -ine $target
  }) -join ';'
  if ($before -ceq $after) { exit 0 }
  $key.SetValue('Path', $after, [Microsoft.Win32.RegistryValueKind]::ExpandString)
} finally {
  $key.Dispose()
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OhbabyPathNotification {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessageTimeout(
    IntPtr window, uint message, UIntPtr wParam, string lParam,
    uint flags, uint timeout, out UIntPtr result);
}
'@
$result = [UIntPtr]::Zero
[void][OhbabyPathNotification]::SendMessageTimeout(
  [IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 2, 1500, [ref]$result)
`;

export async function removeWindowsUserPath(path: string): Promise<void> {
  const encoded = Buffer.from(removeUserPath, "utf16le").toString("base64");
  const { status } = await runInstallerCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { env: { ...process.env, OHBABY_UNINSTALL_BIN: path } },
  );
  if (status !== "0")
    throw new Error(
      `Could not remove the Windows user PATH entry (${status}).`,
    );
}
