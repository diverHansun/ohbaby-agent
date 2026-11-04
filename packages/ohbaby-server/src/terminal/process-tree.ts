import { execFile, execFileSync } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

export interface TerminalProcess {
  pid: number;
  parentPid: number;
  tty: string;
  started: string;
  name: string;
}

const columns = "pid=,ppid=,tty=,lstart=,stat=,comm=";
const psOptions = {
  encoding: "utf8" as const,
  env: { ...process.env, LC_ALL: "C" },
  timeout: 1000,
  maxBuffer: 8 * 1024 * 1024,
};
const exec = promisify(execFile);

export function parseProcessTable(text: string): TerminalProcess[] {
  const rows: TerminalProcess[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s+(.+)$/.exec(
        line,
      );
    if (!match) throw new Error("Unable to parse terminal process table");
    if (/^[ZX]/.test(match[5])) continue;
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      tty: match[3],
      started: match[4].replace(/\s+/g, " "),
      name: basename(match[6]),
    });
  }
  return rows;
}

export async function readProcessTable(): Promise<TerminalProcess[]> {
  const { stdout } = await exec("/bin/ps", ["-A", "-o", columns], psOptions);
  return parseProcessTable(stdout);
}

export function sameProcess(
  left: TerminalProcess,
  right: TerminalProcess,
): boolean {
  return left.pid === right.pid && left.started === right.started;
}

/** Keep captured orphans, but never adopt children of a recycled root PID. */
export function collectTerminalProcesses(
  rows: readonly TerminalProcess[],
  root: TerminalProcess,
  known: readonly TerminalProcess[],
): TerminalProcess[] {
  const members = new Map<number, TerminalProcess>();
  for (const row of rows) {
    if (
      sameProcess(row, root) ||
      known.some((member) => sameProcess(row, member))
    )
      members.set(row.pid, row);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (
        !members.has(row.pid) &&
        members.has(row.parentPid) &&
        row.tty === root.tty &&
        !/^\?+$/.test(row.tty)
      ) {
        members.set(row.pid, row);
        changed = true;
      }
    }
  }
  return [...members.values()];
}

/** Re-read the target immediately before signalling; stale snapshots cannot authorize a kill. */
export function signalTerminalProcess(
  member: TerminalProcess,
  signal: NodeJS.Signals,
): void {
  let rows: TerminalProcess[];
  try {
    rows = parseProcessTable(
      execFileSync(
        "/bin/ps",
        ["-p", String(member.pid), "-o", columns],
        psOptions,
      ),
    );
  } catch (error) {
    if ((error as { status?: number }).status === 1) return; // ps: the process exited.
    throw error;
  }
  if (!rows.some((row) => sameProcess(row, member))) return;
  try {
    process.kill(member.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export function readProcessTableSync(): TerminalProcess[] {
  return parseProcessTable(
    execFileSync("/bin/ps", ["-A", "-o", columns], psOptions),
  );
}
