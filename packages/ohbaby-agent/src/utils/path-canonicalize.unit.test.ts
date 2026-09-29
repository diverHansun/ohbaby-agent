import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

function missing(): NodeJS.ErrnoException {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}
function mockVolume(sensitive: boolean | "unknown", mounted = false): void {
  const entries: Partial<Record<string, { dev: number; ino: number }>> = {
    "/": { dev: 1, ino: 1 },
    "/Mount": { dev: mounted ? 2 : 1, ino: 2 },
    "/Mount/Upper": { dev: mounted ? 2 : 1, ino: 3 },
  };
  vi.spyOn(fs, "realpath").mockImplementation((input) => {
    const name = String(input);
    if (entries[name]) return Promise.resolve(name);
    throw missing();
  });
  vi.spyOn(fs, "stat").mockImplementation((input) => {
    const name = String(input);
    let entry = entries[name];
    if (!entry && (name === "/mount" || name === "/mOUNT")) {
      // Parent filesystem is insensitive even if the mounted volume is not.
      if (mounted || sensitive === false) entry = entries["/Mount"];
    }
    if (
      !entry &&
      (name === "/Mount/upper" || name === "/Mount/uPPER") &&
      sensitive === false
    )
      entry = entries["/Mount/Upper"];
    if (!entry && sensitive === "unknown" && !name.endsWith("New.txt"))
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    if (!entry) throw missing();
    return Promise.resolve(entry as Stats);
  });
}

afterEach(() => vi.restoreAllMocks());
describe.runIf(process.platform === "darwin")(
  "resource path identity by volume",
  () => {
    it.each([true, false, "unknown"] as const)(
      "preserves sensitive volume semantics and conservatively folds %s",
      async (sensitive) => {
        vi.resetModules();
        mockVolume(sensitive);
        const { canonicalizeResourcePath } =
          await import("./path-canonicalize.js");
        expect(await canonicalizeResourcePath("/Mount/Upper/New.txt")).toBe(
          sensitive === true ? "/Mount/Upper/New.txt" : "/mount/upper/new.txt",
        );
      },
    );
    it("does not apply an insensitive parent volume result across a mount boundary", async () => {
      vi.resetModules();
      mockVolume(true, true);
      const { canonicalizeResourcePath } =
        await import("./path-canonicalize.js");
      expect(await canonicalizeResourcePath("/Mount/Upper/New.txt")).toBe(
        "/mount/Upper/New.txt",
      );
      expect(await canonicalizeResourcePath("/Mount")).toBe("/mount");
    });
  },
);
