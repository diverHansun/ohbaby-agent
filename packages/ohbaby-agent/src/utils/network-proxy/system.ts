import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";

export class SystemProxyReadError extends Error {}

export interface SystemProxySettings {
  source: "system" | "unavailable";
  httpProxy?: string;
  httpsProxy?: string;
  bypass?: readonly string[];
  excludeSimpleHostnames?: boolean;
}

interface ReaderOptions {
  platform?: NodeJS.Platform;
  run?: (file: string, args: readonly string[]) => Promise<string>;
}

const execute = promisify(execFile);
const runCommand = async (
  file: string,
  args: readonly string[],
): Promise<string> => {
  const result = await execute(file, [...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  return result.stdout;
};
const invalid = (): never => {
  throw new SystemProxyReadError("System proxy settings are invalid");
};
const unsupportedPac = (): never => {
  throw new SystemProxyReadError("System PAC proxy is not supported");
};

function endpoint(value: string): string {
  if (/\s|@|[/?#]/.test(value)) return invalid();
  try {
    const url = new URL(`http://${value}`);
    const port = /:(\d+)$/.exec(value)?.[1];
    if (!url.hostname || !port || Number(port) < 1 || Number(port) > 65535)
      return invalid();
    return url.href;
  } catch {
    return invalid();
  }
}

function readMac(output: string): SystemProxySettings {
  if (!/^\s*<dictionary>\s*\{[\s\S]*\}\s*$/.test(output)) return invalid();
  const value = (key: string): string | undefined =>
    new RegExp(`^\\s*${key}\\s*:\\s*([^\\r\\n]+)`, "m")
      .exec(output)?.[1]
      ?.trim();
  const enabled = (key: string): boolean => {
    const flag = value(key);
    if (flag !== undefined && flag !== "0" && flag !== "1") return invalid();
    return flag === "1";
  };
  if (enabled("ProxyAutoConfigEnable") || enabled("ProxyAutoDiscoveryEnable"))
    unsupportedPac();
  const result: SystemProxySettings = { source: "system" };
  for (const [prefix, field] of [
    ["HTTP", "httpProxy"],
    ["HTTPS", "httpsProxy"],
  ] as const) {
    if (!enabled(`${prefix}Enable`)) continue;
    const host = value(`${prefix}Proxy`);
    const port = value(`${prefix}Port`);
    if (!host || !port || !/^\d+$/.test(port)) return invalid();
    result[field] = endpoint(
      `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`,
    );
  }
  if (enabled("SOCKSEnable") && (!result.httpProxy || !result.httpsProxy)) {
    throw new SystemProxyReadError("System SOCKS proxy is not supported");
  }
  const exceptions = /ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/.exec(output);
  if (value("ExceptionsList") !== undefined && !exceptions) return invalid();
  if (exceptions?.[1]) {
    result.bypass = exceptions[1]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^\d+\s*:\s*(.+)$/.exec(line);
        return match?.[1]?.trim() ?? invalid();
      });
  }
  if (enabled("ExcludeSimpleHostnames")) result.excludeSimpleHostnames = true;
  return result;
}

// Native current-user WinINet settings avoid localized output and machine WinHTTP settings.
// WPAD discovery only locates a PAC URL: scripts are never downloaded or executed here.
const windowsScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OhbabyProxy {
 [StructLayout(LayoutKind.Sequential)] public struct Config {
  [MarshalAs(UnmanagedType.Bool)] public bool AutoDetect;
  public IntPtr AutoConfigUrl, Proxy, Bypass;
 }
 [DllImport("winhttp.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)]
 public static extern bool WinHttpGetIEProxyConfigForCurrentUser(out Config config);
 [DllImport("winhttp.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)]
 public static extern bool WinHttpDetectAutoProxyConfigUrl(uint flags, out IntPtr url);
 [DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr memory);
}
'@
$config = New-Object OhbabyProxy+Config
if (-not [OhbabyProxy]::WinHttpGetIEProxyConfigForCurrentUser([ref]$config)) { throw 'System proxy read failed' }
$detected = [IntPtr]::Zero
try {
 $pac = [Runtime.InteropServices.Marshal]::PtrToStringUni($config.AutoConfigUrl)
 $errorCode = 0
 if ($config.AutoDetect -and -not $pac) {
  if (-not [OhbabyProxy]::WinHttpDetectAutoProxyConfigUrl(3, [ref]$detected)) {
   $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  }
 }
 @{
  autoDetect = $config.AutoDetect
  autoConfigUrl = $pac
  proxy = [Runtime.InteropServices.Marshal]::PtrToStringUni($config.Proxy)
  bypass = [Runtime.InteropServices.Marshal]::PtrToStringUni($config.Bypass)
  detectedUrl = [Runtime.InteropServices.Marshal]::PtrToStringUni($detected)
  detectionError = $errorCode
 } | ConvertTo-Json -Compress
} finally {
 foreach ($ptr in @($config.AutoConfigUrl, $config.Proxy, $config.Bypass, $detected)) {
  if ($ptr -ne [IntPtr]::Zero) { [void][OhbabyProxy]::GlobalFree($ptr) }
 }
}
`;

function readWindows(output: string): SystemProxySettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.replace(/^\uFEFF/, ""));
  } catch {
    return invalid();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return invalid();
  const data = parsed as Record<string, unknown>;
  if (
    typeof data.autoDetect !== "boolean" ||
    typeof data.detectionError !== "number"
  )
    return invalid();
  for (const key of ["proxy", "bypass", "autoConfigUrl", "detectedUrl"]) {
    if (data[key] !== null && typeof data[key] !== "string") return invalid();
  }
  if (data.autoConfigUrl || data.detectedUrl) unsupportedPac();
  if (data.autoDetect && data.detectionError !== 12180) {
    throw new SystemProxyReadError("System proxy discovery failed");
  }
  const result: SystemProxySettings = { source: "system" };
  if (typeof data.proxy === "string" && data.proxy.trim()) {
    const proxy = data.proxy.trim();
    if (!proxy.includes("=")) {
      result.httpProxy = result.httpsProxy = endpoint(proxy);
    } else {
      let socksEnabled = false;
      for (const entry of proxy.split(";")) {
        if (!entry.trim()) continue;
        const match = /^\s*(http|https|socks|ftp)\s*=\s*(\S+)\s*$/i.exec(entry);
        if (!match?.[1] || !match[2]) return invalid();
        const protocol = match[1].toLowerCase();
        if (protocol === "http") result.httpProxy = endpoint(match[2]);
        else if (protocol === "https") result.httpsProxy = endpoint(match[2]);
        else if (protocol === "socks") socksEnabled = true;
      }
      if (socksEnabled && (!result.httpProxy || !result.httpsProxy)) {
        throw new SystemProxyReadError("System SOCKS proxy is not supported");
      }
      if (!result.httpProxy && !result.httpsProxy)
        throw new SystemProxyReadError(
          "System proxy protocol is not supported",
        );
    }
  }
  if (typeof data.bypass === "string" && data.bypass.trim()) {
    const entries = data.bypass
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const bypass = entries.filter((entry) => entry.toLowerCase() !== "<local>");
    if (bypass.length) result.bypass = bypass;
    if (entries.length !== bypass.length) result.excludeSimpleHostnames = true;
  }
  return result;
}

/** Read this process's host and current user's settings, without changing them. */
export async function readSystemProxy(
  options: ReaderOptions = {},
): Promise<SystemProxySettings> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32")
    return { source: "unavailable" };
  const run = options.run ?? runCommand;
  let output: string;
  try {
    output =
      platform === "darwin"
        ? await run("/usr/sbin/scutil", ["--proxy"])
        : await run(
            win32.join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            ),
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              windowsScript,
            ],
          );
  } catch {
    throw new SystemProxyReadError("System proxy settings could not be read");
  }
  return platform === "darwin" ? readMac(output) : readWindows(output);
}
