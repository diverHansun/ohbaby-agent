import { describe, expect, it } from "vitest";
import { BlockedAudit } from "./blocked-audit.js";

describe("BlockedAudit", () => {
  it("uses normalized reasons, adjacent admission numbers and one contribution per run", async () => {
    const audit = new BlockedAudit();
    const block = (): Promise<void> => Promise.resolve();
    expect(await audit.report("r1", 1, " Wait ", block)).toBe(1);
    expect(await audit.report("r1", 1, "other", block)).toBe(1);
    expect(await audit.report("r2", 2, "WAIT", block)).toBe(2);
    expect(await audit.report("r4", 4, "wait", block)).toBe(1);
    expect(await audit.report("r5", 5, "new reason", block)).toBe(1);
    expect(await audit.report("r4", 4, "wait", block)).toBe(1);
    expect(await audit.report("r6", 6, "new reason", block)).toBe(2);
    expect(await audit.report("r7", 7, "new reason", block)).toBe(3);
  });
  it("does not consume the third admission when persistence fails", async () => {
    const audit = new BlockedAudit();
    const block = (): Promise<void> => Promise.resolve();
    await audit.report("r1", 1, "wait", block);
    await audit.report("r2", 2, "wait", block);
    await expect(
      audit.report("r3", 3, "wait", () => Promise.reject(new Error("append"))),
    ).rejects.toThrow("append");
    expect(await audit.report("r3", 3, "wait", block)).toBe(3);
  });
});
