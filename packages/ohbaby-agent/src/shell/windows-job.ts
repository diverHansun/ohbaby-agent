import { createRequire } from "node:module";

/**
 * One Windows Job Object that owns a spawned command and the descendants that
 * stay inside it. An empty Job is the cleanup evidence; processes that break
 * away from the Job (for example PowerShell `Start-Process`) are outside it.
 */
export interface WindowsJob {
  /** Active member count, or undefined when the query fails. */
  activeProcesses(): number | undefined;
  terminate(): boolean;
  /** Closing a non-empty Job ends its members (KILL_ON_JOB_CLOSE). */
  close(): void;
  readonly closed: boolean;
}

export type WindowsJobAttachment =
  | { readonly kind: "job"; readonly job: WindowsJob }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Native calls, injectable for tests. Handles are opaque. */
export interface WindowsJobApi {
  create(): unknown;
  assign(job: unknown, pid: number): boolean;
  activeProcesses(job: unknown): number | undefined;
  terminate(job: unknown): boolean;
  close(job: unknown): void;
}

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

type Koffi = typeof import("koffi");

function createKoffiApi(koffi: Koffi): WindowsJobApi {
  const kernel32 = koffi.load("kernel32.dll");
  const HANDLE = koffi.pointer("OHBABY_JOB_HANDLE", koffi.opaque());
  const basic = koffi.struct("OHBABY_JOBOBJECT_BASIC_LIMIT_INFORMATION", {
    PerProcessUserTimeLimit: "int64",
    PerJobUserTimeLimit: "int64",
    LimitFlags: "uint32",
    MinimumWorkingSetSize: "size_t",
    MaximumWorkingSetSize: "size_t",
    ActiveProcessLimit: "uint32",
    Affinity: "uintptr_t",
    PriorityClass: "uint32",
    SchedulingClass: "uint32",
  });
  const io = koffi.struct("OHBABY_IO_COUNTERS", {
    ReadOperationCount: "uint64",
    WriteOperationCount: "uint64",
    OtherOperationCount: "uint64",
    ReadTransferCount: "uint64",
    WriteTransferCount: "uint64",
    OtherTransferCount: "uint64",
  });
  const extended = koffi.struct("OHBABY_JOBOBJECT_EXTENDED_LIMIT_INFORMATION", {
    BasicLimitInformation: basic,
    IoInfo: io,
    ProcessMemoryLimit: "size_t",
    JobMemoryLimit: "size_t",
    PeakProcessMemoryUsed: "size_t",
    PeakJobMemoryUsed: "size_t",
  });
  const accounting = koffi.struct(
    "OHBABY_JOBOBJECT_BASIC_ACCOUNTING_INFORMATION",
    {
      TotalUserTime: "int64",
      TotalKernelTime: "int64",
      ThisPeriodTotalUserTime: "int64",
      ThisPeriodTotalKernelTime: "int64",
      TotalPageFaultCount: "uint32",
      TotalProcesses: "uint32",
      ActiveProcesses: "uint32",
      TotalTerminatedProcesses: "uint32",
    },
  );
  type NativeFn = (...args: unknown[]) => unknown;
  const fn = (name: string, result: unknown, args: unknown[]): NativeFn =>
    kernel32.func(
      "__stdcall",
      name,
      result as string,
      args as string[],
    ) as NativeFn;
  const createJobObject = fn("CreateJobObjectW", HANDLE, ["void *", "void *"]);
  const setLimits = fn("SetInformationJobObject", "bool", [
    HANDLE,
    "int",
    koffi.pointer(extended),
    "uint32",
  ]);
  const queryAccounting = fn("QueryInformationJobObject", "bool", [
    HANDLE,
    "int",
    koffi.out(koffi.pointer(accounting)),
    "uint32",
    "void *",
  ]);
  const openProcess = fn("OpenProcess", HANDLE, ["uint32", "bool", "uint32"]);
  const assignProcess = fn("AssignProcessToJobObject", "bool", [
    HANDLE,
    HANDLE,
  ]);
  const terminateJob = fn("TerminateJobObject", "bool", [HANDLE, "uint32"]);
  const closeHandle = fn("CloseHandle", "bool", [HANDLE]);
  return {
    create(): unknown {
      const job = createJobObject(null, null);
      if (!job) return undefined;
      const limits = {
        BasicLimitInformation: {
          LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
      };
      if (
        !setLimits(
          job,
          JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
          limits,
          koffi.sizeof(extended),
        )
      ) {
        closeHandle(job);
        return undefined;
      }
      return job;
    },
    assign(job, pid): boolean {
      const processHandle = openProcess(
        PROCESS_SET_QUOTA | PROCESS_TERMINATE,
        false,
        pid,
      );
      if (!processHandle) return false;
      try {
        return Boolean(assignProcess(job, processHandle));
      } finally {
        closeHandle(processHandle);
      }
    },
    activeProcesses(job): number | undefined {
      const info: { ActiveProcesses?: number } = {};
      const ok = queryAccounting(
        job,
        JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
        info,
        koffi.sizeof(accounting),
        null,
      );
      return ok && typeof info.ActiveProcesses === "number"
        ? info.ActiveProcesses
        : undefined;
    },
    terminate(job): boolean {
      return Boolean(terminateJob(job, 1));
    },
    close(job): void {
      closeHandle(job);
    },
  };
}

let loaded: WindowsJobApi | { readonly error: string } | undefined;

/** Load Koffi synchronously on first use; spawn and job registration are synchronous. */
export function loadWindowsJobApi():
  | WindowsJobApi
  | { readonly error: string } {
  if (loaded) return loaded;
  try {
    const koffi = createRequire(import.meta.url)("koffi") as Koffi;
    loaded = createKoffiApi(koffi);
  } catch (error) {
    loaded = {
      error: `Windows Job support could not load: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return loaded;
}

/** Put a just-spawned process into a new kill-on-close Job. Never throws. */
export function createWindowsJob(
  pid: number,
  api: WindowsJobApi | { readonly error: string } = loadWindowsJobApi(),
): WindowsJobAttachment {
  if ("error" in api) return { kind: "unavailable", reason: api.error };
  let handle: unknown;
  try {
    handle = api.create();
    if (!handle)
      return { kind: "unavailable", reason: "Windows Job creation failed." };
    if (!api.assign(handle, pid)) {
      api.close(handle);
      return {
        kind: "unavailable",
        reason: "The command could not be added to a Windows Job.",
      };
    }
  } catch (error) {
    try {
      if (handle) api.close(handle);
    } catch {
      /* The attach failure is the reported cause. */
    }
    return {
      kind: "unavailable",
      reason: `Windows Job setup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let closed = false;
  return {
    kind: "job",
    job: {
      get closed(): boolean {
        return closed;
      },
      activeProcesses(): number | undefined {
        if (closed) return 0;
        try {
          return api.activeProcesses(handle);
        } catch {
          return undefined;
        }
      },
      terminate(): boolean {
        if (closed) return true;
        try {
          return api.terminate(handle);
        } catch {
          return false;
        }
      },
      close(): void {
        if (closed) return;
        closed = true;
        try {
          api.close(handle);
        } catch {
          /* The handle is released with the runtime at the latest. */
        }
      },
    },
  };
}
