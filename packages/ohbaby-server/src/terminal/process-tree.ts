import { execFile, execFileSync } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { readMacosSessions } from "./macos-session.js";

export interface TerminalProcess {
  pid: number;
  parentPid: number;
  tty: string;
  started: string;
  name: string;
  sessionId?: number;
}

const columns = "pid=,ppid=,tty=,lstart=,stat=,comm=";
const psOptions = {
  encoding: "utf8" as const,
  env: { ...process.env, LC_ALL: "C" },
  timeout: 1000,
  maxBuffer: 8 * 1024 * 1024,
};
const exec = promisify(execFile);

export function parseProcessTable(
  text: string,
  withSession = false,
): TerminalProcess[] {
  const rows: TerminalProcess[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s+(.+)$/.exec(
        line,
      );
    if (!match) throw new Error("Unable to parse terminal process table");
    if (/^[ZX]/.test(match[5])) continue;
    const session = withSession ? /^(\d+)\s+(.+)$/.exec(match[6]) : null;
    if (withSession && !session) throw new Error("Missing process session ID");
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      tty: match[3],
      started: match[4].replace(/\s+/g, " "),
      name: basename(session ? session[2] : match[6]),
      ...(session ? { sessionId: Number(session[1]) } : {}),
    });
  }
  return rows;
}

export async function readProcessTable(): Promise<TerminalProcess[]> {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error(
      "Terminal process inspection is unsupported on this platform",
    );
  const linux = process.platform === "linux";
  const selectedColumns = linux
    ? columns.replace("comm=", "sid=,comm=")
    : columns;
  const { stdout } = await exec(
    "/bin/ps",
    ["-A", "-o", selectedColumns],
    psOptions,
  );
  const rows = parseProcessTable(stdout, linux);
  if (linux) return rows;
  const sessions = await readMacosSessions(rows.map(({ pid }) => pid));
  return rows
    .filter(({ pid }) => sessions.has(pid))
    .map((row) => ({ ...row, sessionId: sessions.get(row.pid) }));
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
  root: TerminalProcess | undefined,
  known: readonly TerminalProcess[],
  sessionId: number,
  adoptSession = false,
): TerminalProcess[] {
  const members = new Map<number, TerminalProcess>();
  const currentRoot = rows.find(({ pid }) => pid === sessionId);
  const mayAdopt =
    adoptSession && (!currentRoot || (root && sameProcess(root, currentRoot)));
  for (const row of rows) {
    if (
      known.some((member) => sameProcess(row, member)) ||
      (row.sessionId === sessionId &&
        (mayAdopt || (root && sameProcess(row, root))))
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
        row.sessionId === members.get(row.parentPid)?.sessionId
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
