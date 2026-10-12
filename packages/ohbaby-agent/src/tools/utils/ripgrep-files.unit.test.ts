import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listFilesWithRipgrep, normalizeGlobPattern } from "./ripgrep-files.js";
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (
      command: string,
      args: readonly string[],
      options: import("node:child_process").SpawnOptions,
    ): import("node:child_process").ChildProcess =>
      command.endsWith("fixture.cjs")
        ? actual.spawn(process.execPath, [command, ...args], options)
        : actual.spawn(command, args, options),
  };
});
describe("Glob bounded NUL path receiver", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-glob-receiver-"));
  });
  afterEach(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });
  async function run(
    source: string,
    options: Partial<Parameters<typeof listFilesWithRipgrep>[0]> = {},
  ): Promise<{
    paths: string[];
    result: Awaited<ReturnType<typeof listFilesWithRipgrep>>;
  }> {
    const executablePath = path.join(root, "fixture.cjs");
    await fs.writeFile(executablePath, source);
    const paths: string[] = [];
    const result = await listFilesWithRipgrep({
      executablePath,
      cwd: root,
      pattern: "**/*",
      signal: new AbortController().signal,
      onPath: (value) => {
        paths.push(value);
        return undefined;
      },
      ...options,
    });
    return { paths, result };
  }
  it("rejects absolute patterns after normalization too", () => {
    for (const pattern of [".//x.ts", "./C:\\x.ts", ".\\\\server\\share\\x.ts"])
      expect(() => normalizeGlobPattern(pattern, "win32")).toThrow("relative");
    expect(normalizeGlobPattern(".\\src\\*.ts", "win32")).toBe("src/*.ts");
  });
  it("decodes split UTF-8 and NUL frames without splitting embedded newlines", async () => {
    const output = Buffer.from("./空 格\n名.ts\0./other.ts\0").toString(
      "base64",
    );
    const result = await run(
      `const data=Buffer.from('${output}','base64'); let i=0; const timer=setInterval(()=>{ if(i===data.length){clearInterval(timer);return;} process.stdout.write(data.subarray(i,i+1));i++; },1);`,
    );
    expect(result.paths).toEqual(["空 格\n名.ts", "other.ts"]);
    expect(result.result.stopReason).toBeUndefined();
  });
  it("fails invalid UTF-8 and partial final frames instead of delivering corrupt paths", async () => {
    await expect(
      run("process.stdout.write(Buffer.from([255,0]));"),
    ).rejects.toThrow("UTF-8");
    await expect(
      run("process.stdout.write('not-terminated');"),
    ).rejects.toThrow("NUL");
  });
  it("accepts normal empty exits and preserves traversal or startup errors", async () => {
    expect((await run("process.exit(1);")).paths).toEqual([]);
    expect((await run("process.exit(0);")).paths).toEqual([]);
    await expect(
      run("process.stderr.write('permission denied');process.exit(2);"),
    ).rejects.toThrow("permission denied");
    await expect(
      listFilesWithRipgrep({
        executablePath: path.join(root, "missing"),
        cwd: root,
        pattern: "*",
        signal: new AbortController().signal,
        onPath: () => undefined,
      }),
    ).rejects.toThrow("unavailable");
  });
  it("bounds individual path frames and diagnostics", async () => {
    expect(
      (await run("process.stdout.write(Buffer.alloc(4*1024*1024+1,120));"))
        .result.stopReason,
    ).toBe("record-limit");
    await expect(
      run("process.stderr.write(Buffer.alloc(64*1024+1,120));"),
    ).rejects.toThrow("64 KiB");
  });
  it("waits for process exit and tree cleanup on quota and cancellation", async () => {
    const pidPath = path.join(root, "pid");
    const source = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid)); if(process.platform!=='win32')process.on('SIGTERM',()=>{}); process.stdout.write('file.ts\\0'); setInterval(()=>{},1000);`;
    const quota = await run(source, { onPath: () => "match-limit" });
    expect(quota.result.stopReason).toBe("match-limit");
    const pid = Number(await fs.readFile(pidPath, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    const controller = new AbortController();
    await expect(
      run(source, {
        signal: controller.signal,
        onPath: () => {
          controller.abort(new Error("caller cancelled"));
          return undefined;
        },
      }),
    ).rejects.toThrow("caller cancelled");
    const cancelledPid = Number(await fs.readFile(pidPath, "utf8"));
    expect(() => process.kill(cancelledPid, 0)).toThrow();
  });
});
