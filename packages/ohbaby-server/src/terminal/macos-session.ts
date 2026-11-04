import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Static system-function bridge. Only numeric PID arguments enter run(); no app
// automation, shell interpolation, third-party FFI, or generated executable.
const SCRIPT = `
ObjC.bindFunction('getsid', ['int', ['int']]);
ObjC.bindFunction('__error', ['int *', []]);
function run(argv) {
  return JSON.stringify(argv.map(function(value) {
    if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 2147483647) throw new Error('Invalid PID');
    var pid = Number(value);
    var sid = $.getsid(pid);
    return [pid, sid, sid < 0 ? $.__error()[0] : 0];
  }));
}`;
const exec = promisify(execFile);
let capability: Promise<void> | undefined;

export function parseMacosSessions(
  text: string,
  pids: readonly number[],
): Map<number, number> {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length !== pids.length)
    throw new Error("Incomplete macOS session inspection");
  const sessions = new Map<number, number>();
  for (let index = 0; index < pids.length; index += 1) {
    const row: unknown = value[index];
    if (
      !Array.isArray(row) ||
      row.length !== 3 ||
      row[0] !== pids[index] ||
      !row.every(Number.isSafeInteger)
    ) {
      throw new Error("Invalid macOS session inspection");
    }
    const [pid, sid, errno] = row as [number, number, number];
    if (sid > 0 && errno === 0) sessions.set(pid, sid);
    else if (sid !== -1 || errno !== 3)
      throw new Error(
        `Cannot inspect process ${String(pid)} session (errno ${String(errno)})`,
      );
  }
  return sessions;
}

export async function readMacosSessions(
  pids: readonly number[],
): Promise<Map<number, number>> {
  const sessions = new Map<number, number>();
  // Bound argv length as well as the subprocess output and execution time.
  for (let offset = 0; offset < pids.length; offset += 1024) {
    const batch = pids.slice(offset, offset + 1024);
    const { stdout } = await exec(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", SCRIPT, ...batch.map(String)],
      {
        encoding: "utf8",
        // osascript can start slowly on a busy or freshly booted machine.
        timeout: 3000,
        maxBuffer: 256 * 1024,
      },
    );
    for (const [pid, sid] of parseMacosSessions(stdout, batch))
      sessions.set(pid, sid);
  }
  return sessions;
}

/**
 * Never launch an unmanageable terminal, but cache only success: a slow first
 * osascript start must not disable terminals until the daemon restarts.
 */
export function ensureMacosSessionSupport(): Promise<void> {
  capability ??= readMacosSessions([process.pid]).then((sessions) => {
    if (!sessions.has(process.pid))
      throw new Error("macOS terminal session inspection unavailable");
  });
  const probe = capability;
  probe.catch(() => {
    if (capability === probe) capability = undefined;
  });
  return probe;
}
