import { describe, expect, it, vi } from "vitest";
import {
  killTreeWithPlatform,
  manageWithWindowsJob,
  probeProcessTree,
} from "./process.js";
import {
  createWindowsJob,
  type WindowsJobApi,
  type WindowsJobAttachment,
} from "./windows-job.js";

function fakeApi(overrides: Partial<WindowsJobApi> = {}): WindowsJobApi {
  return {
    create: vi.fn(() => ({ handle: 1 })),
    assign: vi.fn(() => true),
    activeProcesses: vi.fn(() => 0),
    terminate: vi.fn(() => true),
    close: vi.fn(),
    ...overrides,
  };
}

function jobWith(
  active: () => number | undefined,
  terminate = (): boolean => true,
): {
  attachment: Extract<WindowsJobAttachment, { kind: "job" }>;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const attachment = createWindowsJob(
    7,
    fakeApi({ activeProcesses: active, terminate, close }),
  );
  if (attachment.kind !== "job") throw new Error("expected a job");
  return { attachment, close };
}

describe("createWindowsJob", () => {
  it("reports a load failure as native-unavailable instead of throwing", () => {
    expect(createWindowsJob(7, { error: "koffi missing" })).toEqual({
      kind: "unavailable",
      reason: "koffi missing",
    });
  });

  it("closes the Job when the process cannot be added", () => {
    const close = vi.fn();
    const api = fakeApi({ assign: vi.fn(() => false), close });
    expect(createWindowsJob(7, api).kind).toBe("unavailable");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports thrown native errors as unavailable", () => {
    const api = fakeApi({
      create: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    expect(createWindowsJob(7, api)).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("boom") as unknown,
    });
  });

  it("stops querying and terminating after close", () => {
    const close = vi.fn();
    const terminate = vi.fn(() => true);
    const attachment = createWindowsJob(
      7,
      fakeApi({ activeProcesses: vi.fn(() => 3), close, terminate }),
    );
    if (attachment.kind !== "job") throw new Error("expected a job");
    attachment.job.close();
    attachment.job.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(attachment.job.activeProcesses()).toBe(0);
    expect(attachment.job.terminate()).toBe(true);
    expect(terminate).not.toHaveBeenCalled();
  });
});

describe("Windows Job cleanup evidence", () => {
  it("treats an empty Job as stopped and releases its handle once", () => {
    const { attachment, close } = jobWith(() => 0);
    const options = { platform: "win32" as const, windowsJob: attachment };
    expect(probeProcessTree({ pid: 7 }, options)).toBe("stopped");
    expect(probeProcessTree({ pid: 7 }, options)).toBe("stopped");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps a Job with live members running and its handle open", () => {
    const { attachment, close } = jobWith(() => 1);
    expect(
      probeProcessTree(
        { pid: 7 },
        { platform: "win32", windowsJob: attachment, exited: () => true },
      ),
    ).toBe("running");
    expect(close).not.toHaveBeenCalled();
  });

  it("reports a failed Job query as unknown", () => {
    const { attachment } = jobWith(() => undefined);
    expect(
      probeProcessTree(
        { pid: 7 },
        { platform: "win32", windowsJob: attachment },
      ),
    ).toBe("unknown");
  });

  it("keeps the legacy evidence rule when native support is unavailable", () => {
    const windowsJob: WindowsJobAttachment = {
      kind: "unavailable",
      reason: "koffi missing",
    };
    expect(
      probeProcessTree(
        { pid: 7 },
        { platform: "win32", windowsJob, exited: () => true },
      ),
    ).toBe("unknown");
  });

  it("confirms an already empty Job without terminating it", async () => {
    const terminate = vi.fn(() => true);
    const { attachment } = jobWith(() => 0, terminate);
    expect(
      await killTreeWithPlatform(
        { pid: 7 },
        { platform: "win32", windowsJob: attachment, exited: () => true },
      ),
    ).toEqual({ status: "confirmed" });
    expect(terminate).not.toHaveBeenCalled();
  });

  it("terminates a Job whose leader exited but a member remains", async () => {
    let active = 1;
    const terminate = vi.fn(() => {
      active = 0;
      return true;
    });
    const spawnTaskkill = vi.fn(() => Promise.resolve());
    const { attachment } = jobWith(() => active, terminate);
    expect(
      await killTreeWithPlatform(
        { pid: 7 },
        {
          platform: "win32",
          windowsJob: attachment,
          exited: () => true,
          spawnTaskkill,
        },
      ),
    ).toEqual({ status: "confirmed" });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(spawnTaskkill).not.toHaveBeenCalled();
  });

  it("bounds observation when Job members do not exit", async () => {
    const { attachment } = jobWith(() => 1);
    expect(
      await killTreeWithPlatform(
        { pid: 7 },
        {
          platform: "win32",
          windowsJob: attachment,
          observationMs: 10,
          pollIntervalMs: 1,
          delay: () => Promise.resolve(),
        },
      ),
    ).toEqual({ status: "unconfirmed", reason: "observation-expired" });
  });

  it("reports a failed Job termination", async () => {
    const { attachment } = jobWith(
      () => 1,
      () => false,
    );
    expect(
      await killTreeWithPlatform(
        { pid: 7 },
        { platform: "win32", windowsJob: attachment },
      ),
    ).toEqual({ status: "unconfirmed", reason: "termination-failed" });
  });

  it("names native-unavailable when an exited leader has no Job", async () => {
    const spawnTaskkill = vi.fn(() => Promise.resolve());
    expect(
      await killTreeWithPlatform(
        { pid: 7 },
        {
          platform: "win32",
          windowsJob: { kind: "unavailable", reason: "koffi missing" },
          exited: () => true,
          spawnTaskkill,
        },
      ),
    ).toEqual({
      status: "unconfirmed",
      reason: "native-unavailable",
      detail: "koffi missing",
    });
    expect(spawnTaskkill).not.toHaveBeenCalled();
  });

  it("does not replace failed native attachment evidence with successful taskkill", async () => {
    const windowsJob = {
      kind: "unavailable",
      reason: "assignment failed",
    } as const;
    let exited = false;
    const spawnTaskkill = vi.fn(() => {
      exited = true;
      return Promise.resolve();
    });
    const result = await killTreeWithPlatform(
      { pid: 7 },
      {
        platform: "win32",
        windowsJob,
        exited: () => exited,
        spawnTaskkill,
      },
    );
    expect(spawnTaskkill).toHaveBeenCalledOnce();
    expect(result).toEqual({
      status: "unconfirmed",
      reason: "native-unavailable",
      detail: "assignment failed",
    });
    expect(
      probeProcessTree(
        { pid: 7 },
        {
          platform: "win32",
          windowsJob,
          exited: () => true,
          terminationSucceeded: true,
        },
      ),
    ).toBe("unknown");
    expect(
      await killTreeWithPlatform(
        { pid: 7 },
        {
          platform: "win32",
          windowsJob,
          exited: () => true,
          terminationSucceeded: true,
        },
      ),
    ).toEqual(result);
  });
});

describe("manageWithWindowsJob", () => {
  it("only attaches spawned Windows processes", () => {
    const attach = vi.fn(
      (): WindowsJobAttachment => ({ kind: "unavailable", reason: "x" }),
    );
    manageWithWindowsJob({ pid: 7 }, { platform: "darwin", attach });
    manageWithWindowsJob({ pid: undefined }, { platform: "win32", attach });
    expect(attach).not.toHaveBeenCalled();

    const child = { pid: 7 };
    manageWithWindowsJob(child, { platform: "win32", attach });
    expect(attach).toHaveBeenCalledWith(7);
    // The registered attachment now drives the Windows probe for this child.
    expect(
      probeProcessTree(child, { platform: "win32", exited: () => true }),
    ).toBe("unknown");
  });

  it("uses the registered Job for later probes", () => {
    const { attachment } = jobWith(() => 0);
    const child = { pid: 9 };
    manageWithWindowsJob(child, {
      platform: "win32",
      attach: () => attachment,
    });
    expect(probeProcessTree(child, { platform: "win32" })).toBe("stopped");
  });
});
