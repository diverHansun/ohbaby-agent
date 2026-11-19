import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

interface WindowsProcess {
  readonly ProcessId: number;
  readonly ParentProcessId: number;
  readonly Name: string;
  readonly CommandLine?: string | null;
}

function isProcessRow(value: unknown): value is WindowsProcess {
  return (
    typeof value === "object" &&
    value !== null &&
    "ProcessId" in value &&
    Number.isSafeInteger(value.ProcessId) &&
    "ParentProcessId" in value &&
    Number.isSafeInteger(value.ParentProcessId) &&
    "Name" in value &&
    typeof value.Name === "string" &&
    (!("CommandLine" in value) ||
      value.CommandLine === null ||
      typeof value.CommandLine === "string")
  );
}

function isOhbabyShim(process: WindowsProcess): boolean {
  return (
    /^(?:cmd|powershell|pwsh)(?:\.exe)?$/i.test(process.Name) &&
    /(?:^|[\\/\s"'\x60])ohbaby\.(?:cmd|ps1)(?=$|[\s"'\x60])/i.test(
      process.CommandLine ?? "",
    )
  );
}

function isOhbabyProcess(process: WindowsProcess): boolean {
  return (
    /^ohbaby(?:-cli)?(?:\.(?:exe|cmd|ps1))?$/i.test(process.Name) ||
    (/^node(?:\.exe)?$/i.test(process.Name) &&
      /(?:^|[\\/])ohbaby-cli[\\/]dist[\\/]bin\.js(?=$|[\s"'\x60])/i.test(
        process.CommandLine ?? "",
      )) ||
    isOhbabyShim(process)
  );
}

function processChain(
  byPid: ReadonlyMap<number, WindowsProcess>,
  start: number | undefined,
): ReadonlySet<number> {
  const chain = new Set<number>();
  let pid = start ?? 0;
  while (pid > 0 && !chain.has(pid)) {
    chain.add(pid);
    pid = byPid.get(pid)?.ParentProcessId ?? 0;
  }
  return chain;
}

export function findOtherWindowsOhbabyProcesses(
  rows: readonly WindowsProcess[],
  currentPid: number,
  verifiedDaemonPid: number | undefined,
): readonly number[] {
  const byPid = new Map(rows.map((row) => [row.ProcessId, row]));
  const callerChain = processChain(byPid, currentPid);
  const daemonChain = processChain(byPid, verifiedDaemonPid);
  return rows
    .filter(
      (row) =>
        !callerChain.has(row.ProcessId) &&
        row.ProcessId !== verifiedDaemonPid &&
        !(daemonChain.has(row.ProcessId) && isOhbabyShim(row)) &&
        isOhbabyProcess(row),
    )
    .map((row) => row.ProcessId);
}

export async function findWindowsInstallBlockers(
  env: Readonly<NodeJS.ProcessEnv>,
  verifiedDaemonPid: number | undefined,
): Promise<readonly number[]> {
  const { stdout } = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ],
    {
      encoding: "utf8",
      env,
      timeout: 8_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (
    !rows.every(isProcessRow) ||
    !rows.some((row) => row.ProcessId === process.pid)
  )
    throw new Error("Could not verify the Windows process list.");
  return findOtherWindowsOhbabyProcesses(rows, process.pid, verifiedDaemonPid);
}
