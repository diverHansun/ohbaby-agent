import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveBundledRipgrepPath,
  searchWithRipgrep,
} from "./ripgrep-search.js";

// Adapt only our .cjs fixtures; spawn and process cleanup remain real. Windows
// cannot execute POSIX shebang files. Production rg and taskkill are untouched.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn(
      command: string,
      args: readonly string[],
      options: import("node:child_process").SpawnOptions,
    ): import("node:child_process").ChildProcess {
      return command.endsWith("fixture.cjs")
        ? actual.spawn(process.execPath, [command, ...args], options)
        : actual.spawn(command, args, options);
    },
  };
});

// Controlled executable fixtures are used only for OS failure/stream states
// that the real rg cannot reliably produce. The tool suite uses bundled rg.
describe("bounded ripgrep process receiver", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "rg-receiver-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  async function executable(source: string): Promise<string> {
    const file = path.join(root, "fixture.cjs");
    await fs.writeFile(file, source);
    return file;
  }
  const match =
    JSON.stringify({
      type: "match",
      data: {
        path: { text: "file.txt" },
        line_number: 1,
        lines: { text: "needle\n" },
        submatches: [{ start: 0 }],
      },
    }) + "\n";
  function run(
    executablePath: string,
    signal = new AbortController().signal,
    onMatch: Parameters<typeof searchWithRipgrep>[0]["onMatch"] = () =>
      undefined,
  ): ReturnType<typeof searchWithRipgrep> {
    return searchWithRipgrep({
      executablePath,
      target: root,
      cwd: root,
      pattern: "needle",
      signal,
      onMatch,
    });
  }

  it("fails explicitly if the executable is missing", async () => {
    await expect(run(path.join(root, "missing"))).rejects.toThrow(
      /Search unavailable/,
    );
  });

  it.skipIf(process.platform === "win32")(
    "fails explicitly when POSIX executable permission is missing",
    async () => {
      const file = path.join(root, "not-executable");
      await fs.writeFile(file, "", { mode: 0o644 });
      await expect(run(file)).rejects.toThrow(/Search unavailable/);
    },
  );

  it("waits for physical exit after cancellation", async () => {
    const controller = new AbortController();
    const file = await executable(
      `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "pid"))}, String(process.pid)); if (process.platform !== 'win32') process.on('SIGTERM', () => {}); process.stdout.write(${JSON.stringify(match)}); setInterval(() => {}, 1000);`,
    );
    await expect(
      run(file, controller.signal, () => {
        controller.abort(new Error("Search cancelled by caller"));
        return undefined;
      }),
    ).rejects.toThrow(/cancelled/);
    const pid = Number(await fs.readFile(path.join(root, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("preserves timeout reasons after terminating the process", async () => {
    const controller = new AbortController();
    const file = await executable(
      `process.stdout.write(${JSON.stringify(match)}); setInterval(() => {}, 1000);`,
    );
    const timeout = new DOMException(
      "Search deadline exceeded",
      "TimeoutError",
    );
    await expect(
      run(file, controller.signal, () => {
        controller.abort(timeout);
        return undefined;
      }),
    ).rejects.toBe(timeout);
  });

  it("waits for process exit on a planned result quota stop", async () => {
    const file = await executable(
      `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "pid"))}, String(process.pid)); if (process.platform !== 'win32') process.on('SIGTERM', () => {}); process.stdout.write(${JSON.stringify(match)}); setInterval(() => {}, 1000);`,
    );
    const result = await run(file, undefined, () => "match-limit");
    expect(result).toMatchObject({
      stopReason: "match-limit",
      processExited: true,
    });
    const pid = Number(await fs.readFile(path.join(root, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it.each([
    ["process.stdout.write('bad json\\n')", /invalid ripgrep output/],
    [
      `process.stdout.write(${JSON.stringify(match)})`,
      /complete search summary/,
    ],
    [
      "process.stderr.write('read permission denied\\n'); process.exitCode = 2",
      /permission denied/,
    ],
    ["process.stderr.write('x'.repeat(70000))", /stderr limit/],
  ])(
    "rejects failed or incomplete process protocol %s",
    async (source, message) => {
      await expect(run(await executable(source))).rejects.toThrow(message);
    },
  );

  it("caps total stdout even when individual records are small", async () => {
    const file = await executable(
      "const line = JSON.stringify({type:'begin',data:{path:{text:'x'.repeat(10000)}}})+'\\n'; function write() { while(process.stdout.write(line)) {} process.stdout.once('drain',write); } write();",
    );
    const result = await run(file);
    expect(result).toMatchObject({
      stopReason: "stdout-limit",
      processExited: true,
    });
  });

  it("rejects an undeliverable non-UTF8 path instead of inventing a location", async () => {
    const record =
      JSON.stringify({
        type: "match",
        data: {
          path: { bytes: "/w==" },
          lines: { text: "needle" },
          line_number: 1,
          submatches: [{ start: 0 }],
        },
      }) + "\n";
    await expect(
      run(await executable(`process.stdout.write(${JSON.stringify(record)})`)),
    ).rejects.toThrow(/location cannot be delivered reliably/);
  });

  it("resolves the packaged binary and searches without any PATH rg", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "needle\n");
    const previous = process.env.PATH;
    process.env.PATH = root;
    try {
      let found = "";
      const result = await run(
        resolveBundledRipgrepPath(),
        undefined,
        (event) => {
          found = event.path;
          return undefined;
        },
      );
      expect(found).toContain("a.txt");
      expect(result).toMatchObject({ processExited: true });
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });
});
