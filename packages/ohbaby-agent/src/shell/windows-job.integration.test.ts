import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { killTree, manageWithWindowsJob, probeProcessTree } from "./process.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Real Job Objects exist only on Windows; other platforms keep process groups.
describe.runIf(process.platform === "win32")("Windows Job cleanup", () => {
  it("confirms a naturally exited command from an empty Job", async () => {
    const child = spawn(
      "pwsh.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 7"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    manageWithWindowsJob(child);
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).toBe(7);
    expect(probeProcessTree(child)).toBe("stopped");
    expect(await killTree(child)).toEqual({ status: "confirmed" });
  });

  it("keeps a left-behind descendant running until the Job is terminated", async () => {
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "ignore" }); c.unref(); process.stdout.write(String(c.pid));`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    manageWithWindowsJob(parent);
    let output = "";
    parent.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    await once(parent, "exit");
    const grandchild = Number(output.trim());
    try {
      expect(alive(grandchild)).toBe(true);
      // The leader's exit is not proof: its descendant is still in the Job.
      expect(probeProcessTree(parent)).toBe("running");
      expect(await killTree(parent)).toEqual({ status: "confirmed" });
      expect(alive(grandchild)).toBe(false);
    } finally {
      if (alive(grandchild)) process.kill(grandchild);
    }
  });
});
