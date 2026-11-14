import { describe, expect, it, vi } from "vitest";
import { readProcessIdentity } from "./process-identity.js";

function macosRow(pid: number, pgid: number, micros = 123456n): string {
  const data = Buffer.alloc(136);
  data.writeUInt32LE(pid, 12);
  data.writeUInt32LE(pgid, 100);
  data.writeBigUInt64LE(1800000000n, 120);
  data.writeBigUInt64LE(micros, 128);
  return JSON.stringify({
    pid,
    bytes: 136,
    errno: 0,
    data: data.toString("base64"),
  });
}

describe("process birth identity", () => {
  it("retains macOS microsecond precision and validates the actual PID", async () => {
    const readMacos = vi.fn().mockResolvedValue(macosRow(42, 42));
    const result = await readProcessIdentity(42, {
      platform: "darwin",
      readMacos,
    });
    expect(result).toEqual({
      state: "present",
      pid: 42,
      pgid: 42,
      startToken: "darwin:1800000000:123456",
    });
    readMacos.mockResolvedValue(macosRow(42, 42, 123457n));
    expect(
      await readProcessIdentity(42, { platform: "darwin", readMacos }),
    ).not.toEqual(result);
    readMacos.mockResolvedValue(macosRow(43, 42));
    expect(
      await readProcessIdentity(42, { platform: "darwin", readMacos }),
    ).toMatchObject({ state: "unknown" });
  });

  it("distinguishes missing processes from permission, ABI and bridge failures", async () => {
    for (const [bytes, errno, expected] of [
      [0, 3, "absent"],
      [0, 1, "unknown"],
      [128, 0, "unknown"],
    ] as const) {
      expect(
        await readProcessIdentity(42, {
          platform: "darwin",
          readMacos: vi
            .fn()
            .mockResolvedValue(
              JSON.stringify({ pid: 42, bytes, errno, data: "" }),
            ),
        }),
      ).toMatchObject({ state: expected });
    }
    expect(
      await readProcessIdentity(42, {
        platform: "darwin",
        readMacos: vi.fn().mockRejectedValue(new Error("timeout")),
      }),
    ).toMatchObject({ state: "unknown" });
    expect(
      await readProcessIdentity(42, {
        platform: "darwin",
        readMacos: vi.fn().mockResolvedValue("not JSON"),
      }),
    ).toMatchObject({ state: "unknown" });
  });

  it("reads Linux start ticks without confusing parentheses in process names", async () => {
    const fields = [
      "S",
      "1",
      "42",
      ...Array<string>(16).fill("0"),
      "12345678901234567890",
    ];
    const readFile = vi.fn((path: string) =>
      Promise.resolve(
        path.endsWith("/stat")
          ? `42 (name ) with spaces) ${fields.join(" ")}`
          : "12345678-1234-1234-1234-123456789abc\n",
      ),
    );
    expect(
      await readProcessIdentity(42, { platform: "linux", readFile }),
    ).toEqual({
      state: "present",
      pid: 42,
      pgid: 42,
      startToken:
        "linux:12345678-1234-1234-1234-123456789abc:12345678901234567890",
    });
    expect(
      await readProcessIdentity(42, {
        platform: "linux",
        probePid: () => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        },
        readFile: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error("missing"), { code: "ENOENT" }),
          ),
      }),
    ).toEqual({ state: "absent" });
    expect(
      await readProcessIdentity(42, {
        platform: "linux",
        readFile: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error("denied"), { code: "EACCES" }),
          ),
      }),
    ).toMatchObject({ state: "unknown" });
  });

  it("never treats missing boot identity or malformed stat as absent", async () => {
    expect(
      await readProcessIdentity(42, {
        platform: "linux",
        readFile: vi.fn().mockResolvedValue("bad"),
      }),
    ).toMatchObject({ state: "unknown" });
    const stat = `42 (sh) S 1 42 ${Array<string>(16).fill("0").join(" ")} 99`;
    expect(
      await readProcessIdentity(42, {
        platform: "linux",
        readFile: (path) =>
          path.endsWith("/stat")
            ? Promise.resolve(stat)
            : Promise.reject(
                Object.assign(new Error("missing boot id"), { code: "ENOENT" }),
              ),
      }),
    ).toMatchObject({ state: "unknown" });
  });

  it("does not confuse hidden procfs entries with dead processes", async () => {
    const readFile = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("hidden"), { code: "ENOENT" }),
      );
    expect(
      await readProcessIdentity(42, {
        platform: "linux",
        readFile,
        probePid: vi.fn(),
      }),
    ).toMatchObject({ state: "unknown" });
    expect(
      await readProcessIdentity(42, {
        platform: "linux",
        readFile,
        probePid: () => {
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        },
      }),
    ).toMatchObject({ state: "unknown" });
  });

  it("does not inspect invalid PIDs or unsupported platforms", async () => {
    const readMacos = vi.fn();
    for (const pid of [0, -1, 1.5, Infinity, 2147483648]) {
      expect(
        await readProcessIdentity(pid, { platform: "darwin", readMacos }),
      ).toMatchObject({ state: "unknown" });
    }
    expect(readMacos).not.toHaveBeenCalled();
    expect(
      await readProcessIdentity(42, { platform: "win32", probePid: vi.fn() }),
    ).toMatchObject({
      state: "unknown",
    });
  });

  it("can prove a dead owner on an unsupported platform without inventing birth identity", async () => {
    expect(
      await readProcessIdentity(42, {
        platform: "win32",
        probePid: () => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        },
      }),
    ).toEqual({ state: "absent" });
  });
});
