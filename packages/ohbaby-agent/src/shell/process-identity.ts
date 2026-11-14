import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

export type ProcessIdentity =
  | {
      readonly state: "present";
      readonly pid: number;
      readonly pgid: number;
      readonly startToken: string;
    }
  | { readonly state: "absent" }
  | { readonly state: "unknown"; readonly reason: string };

export interface ProcessIdentityOptions {
  readonly platform?: NodeJS.Platform;
  readonly readFile?: (path: string) => Promise<string>;
  readonly readMacos?: (pid: number) => Promise<string>;
  readonly probePid?: (pid: number) => void;
}

// sys/proc_info.h: proc_bsdinfo on supported Darwin x86_64/arm64.
const BSD_INFO = {
  size: 136,
  pid: 12,
  pgid: 100,
  startSeconds: 120,
  startMicros: 128,
} as const;

// Static libproc bridge, matching Darwin's 136-byte proc_bsdinfo ABI. Numeric
// arguments only; no shell, app automation, third-party FFI or compiled helper.
const MACOS_SCRIPT = `
ObjC.import('Foundation');
ObjC.bindFunction('proc_pidinfo', ['int', ['int', 'int', 'unsigned long long', 'void *', 'int']]);
ObjC.bindFunction('__error', ['int *', []]);
function run(argv) {
  if (argv.length !== 1 || !/^[1-9][0-9]*$/.test(argv[0]) || Number(argv[0]) > 2147483647) throw new Error('Invalid PID');
  var pid = Number(argv[0]);
  var data = $.NSMutableData.dataWithLength(136);
  var bytes = $.proc_pidinfo(pid, 3, 0, data.mutableBytes, 136);
  var errno = bytes <= 0 ? $.__error()[0] : 0;
  return JSON.stringify({pid: pid, bytes: bytes, errno: errno, data: ObjC.unwrap(data.base64EncodedStringWithOptions(0))});
}`;
const exec = promisify(execFile);

function unknown(reason: string): ProcessIdentity {
  return { state: "unknown", reason };
}

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647;
}

async function readMacos(pid: number): Promise<string> {
  const { stdout } = await exec(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", MACOS_SCRIPT, String(pid)],
    {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 4096,
    },
  );
  return stdout;
}

function parseMacos(text: string, pid: number): ProcessIdentity {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object")
    return unknown("Invalid macOS process response");
  const row = value as Record<string, unknown>;
  if (row.pid !== pid) return unknown("Process response PID mismatch");
  if (row.bytes === 0 && row.errno === 3) return { state: "absent" };
  if (
    row.bytes !== BSD_INFO.size ||
    row.errno !== 0 ||
    typeof row.data !== "string"
  )
    return unknown("macOS process identity unavailable");
  const data = Buffer.from(row.data, "base64");
  if (data.length !== BSD_INFO.size || data.readUInt32LE(BSD_INFO.pid) !== pid)
    return unknown("Unexpected proc_bsdinfo ABI");
  const pgid = data.readUInt32LE(BSD_INFO.pgid);
  const seconds = data.readBigUInt64LE(BSD_INFO.startSeconds);
  const micros = data.readBigUInt64LE(BSD_INFO.startMicros);
  if (!validPid(pgid) || seconds === 0n || micros >= 1000000n)
    return unknown("Invalid process birth identity");
  return {
    state: "present",
    pid,
    pgid,
    startToken: `darwin:${String(seconds)}:${String(micros)}`,
  };
}

async function readLinux(
  pid: number,
  read: (path: string) => Promise<string>,
  probePid: (pid: number) => void,
): Promise<ProcessIdentity> {
  let stat: string;
  try {
    stat = await read(`/proc/${String(pid)}/stat`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // procfs may be unmounted or hide a live process. Only ESRCH from the
      // kernel's signal-0 probe is evidence that this numeric PID is absent.
      try {
        probePid(pid);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === "ESRCH")
          return { state: "absent" };
      }
      return unknown("Process exists or is inaccessible outside procfs");
    }
    throw error;
  }
  // comm can contain whitespace and ')'; everything after the final ')' starts
  // at field 3. Do not round the kernel's 64-bit start ticks through Number.
  const close = stat.lastIndexOf(")");
  if (!stat.startsWith(`${String(pid)} (`) || close < 0)
    return unknown("Invalid proc stat");
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const group = fields[2];
  const pgid = Number(group);
  const ticks = fields[19];
  if (
    !group ||
    !/^[0-9]+$/.test(group) ||
    !validPid(pgid) ||
    !ticks ||
    !/^[0-9]+$/.test(ticks)
  )
    return unknown("Incomplete proc stat");
  const bootId = (await read("/proc/sys/kernel/random/boot_id")).trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      bootId,
    )
  )
    return unknown("Invalid Linux boot identity");
  return {
    state: "present",
    pid,
    pgid,
    startToken: `linux:${bootId}:${ticks}`,
  };
}

/** A failed probe never authorizes signaling a recovered numeric PID. */
export async function readProcessIdentity(
  pid: number,
  options: ProcessIdentityOptions = {},
): Promise<ProcessIdentity> {
  if (!validPid(pid)) return unknown("Invalid PID");
  try {
    switch (options.platform ?? process.platform) {
      case "darwin":
        return parseMacos(await (options.readMacos ?? readMacos)(pid), pid);
      case "linux":
        return await readLinux(
          pid,
          options.readFile ??
            ((file): Promise<string> => readFile(file, "utf8")),
          options.probePid ??
            ((target): void => {
              process.kill(target, 0);
            }),
        );
      default:
        try {
          (
            options.probePid ??
            ((target): void => {
              process.kill(target, 0);
            })
          )(pid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH")
            return { state: "absent" };
        }
        return unknown("Process birth identity unsupported on this platform");
    }
  } catch (error) {
    return unknown(
      error instanceof Error
        ? error.message
        : "Process identity inspection failed",
    );
  }
}
