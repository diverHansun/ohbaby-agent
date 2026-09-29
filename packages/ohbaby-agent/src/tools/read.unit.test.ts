import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../core/tool-scheduler/index.js";
import { createReadTool } from "./read.js";

interface TestContext extends ToolExecutionContext {
  existingCalls: number;
  resolvePath(inputPath: string): string;
  resolvePathForExisting(inputPath: string): Promise<string>;
  resolvePathForWrite(inputPath: string): Promise<string>;
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${candidate}`);
  }
}

function createTestContext(root: string): TestContext {
  return {
    callId: "call_1",
    existingCalls: 0,
    messageId: "message_1",
    sessionId: "session_1",
    signal: new AbortController().signal,
    resolvePath(inputPath: string): string {
      const resolved = path.resolve(root, inputPath);
      assertInside(root, resolved);
      return resolved;
    },
    async resolvePathForExisting(inputPath: string): Promise<string> {
      this.existingCalls += 1;
      const resolved = await fs.realpath(path.resolve(root, inputPath));
      assertInside(root, resolved);
      return resolved;
    },
    async resolvePathForWrite(inputPath: string): Promise<string> {
      const target = path.resolve(root, inputPath);
      const realParent = await fs.realpath(path.dirname(target));
      const resolved = path.join(realParent, path.basename(target));
      assertInside(root, resolved);
      return resolved;
    },
  };
}

async function writeFile(
  root: string,
  relativePath: string,
  content: string | Buffer,
): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

describe("read file tool", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-read-tool-")),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("does not classify a short control-character tail as a new binary sample", async () => {
    const firstLine = "a".repeat(16_383);
    await writeFile(tempRoot, "terminal.log", firstLine + "\n\x1b\x1b\n");
    const tool = createReadTool();
    const context = createTestContext(tempRoot);
    const first = await tool.execute(
      { file_path: "terminal.log", limit: 1 },
      context,
    );
    expect(first.output).toContain("1: " + firstLine);
    const continued = await tool.execute(
      {
        file_path: "terminal.log",
        cursor: first.metadata?.nextCursor,
        limit: 1,
      },
      context,
    );
    expect(continued.output).toBe("2: \x1b\x1b");
    const offset = await tool.execute(
      { file_path: "terminal.log", offset: 2 },
      context,
    );
    expect(offset.output).toBe(continued.output);
    const complete = await tool.execute({ file_path: "terminal.log" }, context);
    expect(complete.output).toBe("1: " + firstLine + "\n2: \x1b\x1b");
  });

  it("limits the control-character ratio heuristic to the first 4096 bytes", async () => {
    const text = "a".repeat(4096) + "\x1b".repeat(4000);
    await writeFile(tempRoot, "terminal.log", text);
    const result = await createReadTool().execute(
      { file_path: "terminal.log" },
      createTestContext(tempRoot),
    );
    expect(result.output).toBe("1: " + text);
  });

  it("still rejects NUL bytes after the initial binary sample", async () => {
    await writeFile(tempRoot, "binary.txt", "a".repeat(16_384) + "\0");
    await expect(
      createReadTool().execute(
        { file_path: "binary.txt" },
        createTestContext(tempRoot),
      ),
    ).rejects.toThrow("Binary files cannot be read as text");
  });

  it("returns line-numbered pages with UTF-8, mtime, size, line ending, and continuation metadata", async () => {
    await writeFile(tempRoot, "notes.txt", "\uFEFFalpha\r\nbeta\r\ngamma\r\n");
    const context = createTestContext(tempRoot);

    const result = await createReadTool().execute(
      { file_path: "notes.txt", limit: 2, offset: 1 },
      context,
    );

    expect(result.output).toContain("1: alpha");
    expect(result.output).toContain("2: beta");
    expect(result.output).not.toContain("3: gamma");
    expect(result.metadata).toMatchObject({
      encoding: "utf8",
      hasMore: true,
      lineEnding: "CRLF",
      nextOffset: 3,
      shownLineCount: 2,
    });
    expect(result.metadata).not.toHaveProperty("lineCount");
    expect(result.metadata?.mtimeMs).toEqual(expect.any(Number));
    expect(result.metadata?.sizeBytes).toBe(
      Buffer.byteLength("\uFEFFalpha\r\nbeta\r\ngamma\r\n"),
    );
  });

  it("reports empty files without a next page", async () => {
    await writeFile(tempRoot, "empty.txt", "");
    const context = createTestContext(tempRoot);

    const result = await createReadTool().execute(
      { file_path: "empty.txt" },
      context,
    );

    expect(result.output).toBe("");
    expect(result.metadata).toMatchObject({
      hasMore: false,
      lineCount: 0,
      nextOffset: undefined,
      shownLineCount: 0,
    });
  });

  it("rejects binary files detected from extension or content sample", async () => {
    await writeFile(tempRoot, "image.png", "not really text");
    await writeFile(tempRoot, "sample.txt", Buffer.from([0x61, 0x00, 0x62]));
    const context = createTestContext(tempRoot);
    const read = createReadTool();

    await expect(
      read.execute({ file_path: "image.png" }, context),
    ).rejects.toThrow("Binary files cannot be read as text");
    await expect(
      read.execute({ file_path: "sample.txt" }, context),
    ).rejects.toThrow("Binary files cannot be read as text");
  });
  it("reads a small range from a large file without requiring a total line count", async () => {
    await writeFile(
      tempRoot,
      "large.txt",
      "first\n" + "tail\n".repeat(250_000),
    );
    const result = await createReadTool().execute(
      { file_path: "large.txt", limit: 1 },
      createTestContext(tempRoot),
    );
    expect(result.output).toContain("1: first");
    expect(result.metadata).not.toHaveProperty("lineCount");
    expect(result.metadata?.hasMore).toBe(true);
  });

  it("delivers every multibyte character of a long line across bounded stateless pages", async () => {
    const content = "汉😀z".repeat(18_000);
    await writeFile(tempRoot, "long.txt", "\uFEFF" + content + "\r\nend");
    const context = createTestContext(tempRoot);
    let cursor: unknown;
    let delivered = "";
    let pages = 0;
    do {
      const result = await createReadTool().execute(
        { file_path: "long.txt", limit: 1, ...(cursor ? { cursor } : {}) },
        context,
      );
      expect(Buffer.byteLength(result.output ?? "")).toBeLessThanOrEqual(
        51_200,
      );
      expect(result.output).not.toContain("�");
      delivered += (result.output ?? "")
        .split("\n")
        .filter((line) => /^1(?: \[continued\])?: /u.test(line))
        .map((line) => line.replace(/^1(?: \[continued\])?: /u, ""))
        .join("");
      cursor = result.metadata?.nextCursor;
      if (typeof cursor === "string") expect(result.output).toContain(cursor);
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);
    expect(delivered).toBe(content);
    expect(pages).toBeGreaterThan(2);
    expect(context.existingCalls).toBe(pages);
  });

  it("rejects stale and malformed cursors and conflicting offsets", async () => {
    await writeFile(tempRoot, "notes.txt", "a\nb\nc");
    const context = createTestContext(tempRoot);
    const read = createReadTool();
    const first = await read.execute(
      { file_path: "notes.txt", limit: 1 },
      context,
    );
    const cursor = first.metadata?.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    await expect(
      read.execute({ file_path: "notes.txt", cursor, offset: 1 }, context),
    ).rejects.toThrow(/cursor.*offset/iu);
    await expect(
      read.execute({ file_path: "notes.txt", cursor: "bad" }, context),
    ).rejects.toThrow(/cursor/iu);
    await writeFile(tempRoot, "other.txt", "a\nb\nc");
    await expect(
      read.execute({ file_path: "other.txt", cursor }, context),
    ).rejects.toThrow(/cursor/iu);
    await fs.appendFile(path.join(tempRoot, "notes.txt"), "d");
    await expect(
      read.execute({ file_path: "notes.txt", cursor }, context),
    ).rejects.toThrow(/file has changed.*read.*again/iu);
  });

  it("rejects malformed UTF-8 and supports cancellation", async () => {
    await writeFile(tempRoot, "bad.txt", Buffer.from([0x61, 0xc0, 0xaf]));
    await expect(
      createReadTool().execute(
        { file_path: "bad.txt" },
        createTestContext(tempRoot),
      ),
    ).rejects.toThrow(/UTF-8/iu);
    await writeFile(tempRoot, "ok.txt", "okay");
    const controller = new AbortController();
    controller.abort();
    await expect(
      createReadTool().execute(
        { file_path: "ok.txt" },
        { ...createTestContext(tempRoot), signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  it("counts a continued line against each page limit and reports exact totals only at EOF", async () => {
    const long = "x".repeat(60_000);
    await writeFile(tempRoot, "count.txt", long + "\nsecond\nthird\n");
    const context = createTestContext(tempRoot);
    const first = await createReadTool().execute(
      { file_path: "count.txt", limit: 1 },
      context,
    );
    expect(first.output?.length).toBeGreaterThan(32_000);
    const second = await createReadTool().execute(
      { file_path: "count.txt", cursor: first.metadata?.nextCursor, limit: 2 },
      context,
    );
    expect(second.output).toContain("1 [continued]: ");
    expect(second.output).toContain("2: second");
    expect(second.output).not.toContain("3: third");
    expect(second.metadata).toMatchObject({ shownLineCount: 2, nextOffset: 3 });
    const third = await createReadTool().execute(
      { file_path: "count.txt", cursor: second.metadata?.nextCursor },
      context,
    );
    expect(third.output).toBe("3: third");
    expect(third.metadata).toMatchObject({ lineCount: 3, hasMore: false });
    expect(third.metadata?.nextCursor).toBeUndefined();
  });

  it("uses the default 2000 source line limit and permits an offset past EOF", async () => {
    await writeFile(tempRoot, "many.txt", "x\n".repeat(2001));
    const context = createTestContext(tempRoot);
    const first = await createReadTool().execute(
      { file_path: "many.txt" },
      context,
    );
    expect(first.metadata).toMatchObject({
      shownLineCount: 2000,
      nextOffset: 2001,
    });
    const beyond = await createReadTool().execute(
      { file_path: "many.txt", offset: 3000 },
      context,
    );
    expect(beyond.output).toBe("");
    expect(beyond.metadata).toMatchObject({
      shownLineCount: 0,
      lineCount: 2001,
      hasMore: false,
    });
  });

  it.each(["append", "truncate", "same-size", "replace"])(
    "rejects %s changes between pages",
    async (kind) => {
      await writeFile(tempRoot, "change.txt", "a\nb\n");
      const context = createTestContext(tempRoot);
      const first = await createReadTool().execute(
        { file_path: "change.txt", limit: 1 },
        context,
      );
      const target = path.join(tempRoot, "change.txt");
      if (kind === "append") await fs.appendFile(target, "z");
      if (kind === "truncate") await fs.truncate(target, 2);
      if (kind === "same-size") {
        await fs.writeFile(target, "x\ny\n");
        await fs.utimes(target, new Date(), new Date(Date.now() + 1000));
      }
      if (kind === "replace") {
        await writeFile(tempRoot, "replacement.txt", "a\nb\n");
        await fs.rename(path.join(tempRoot, "replacement.txt"), target);
      }
      await expect(
        createReadTool().execute(
          { file_path: "change.txt", cursor: first.metadata?.nextCursor },
          context,
        ),
      ).rejects.toThrow(/File has changed/u);
    },
  );

  it("handles BOM-only files, final missing newline, and CRLF at an I/O boundary", async () => {
    await writeFile(tempRoot, "bom.txt", "\uFEFF");
    const context = createTestContext(tempRoot);
    expect(
      (await createReadTool().execute({ file_path: "bom.txt" }, context))
        .metadata,
    ).toMatchObject({ lineCount: 0, shownLineCount: 0 });
    await writeFile(tempRoot, "boundary.txt", "a".repeat(16383) + "\r\n汉😀");
    const result = await createReadTool().execute(
      { file_path: "boundary.txt" },
      context,
    );
    expect(result.output).toBe("1: " + "a".repeat(16383) + "\n2: 汉😀");
    expect(result.metadata).toMatchObject({ lineCount: 2, lineEnding: "CRLF" });
  });

  it("rejects invalid UTF-8 split across blocks while leaving an unscanned tail alone", async () => {
    await writeFile(
      tempRoot,
      "split.txt",
      Buffer.concat([
        Buffer.alloc(16383, 0x61),
        Buffer.from([0xe2, 0x28, 0xa1]),
      ]),
    );
    const context = createTestContext(tempRoot);
    await expect(
      createReadTool().execute({ file_path: "split.txt" }, context),
    ).rejects.toThrow(/UTF-8/u);
    await writeFile(
      tempRoot,
      "tail.txt",
      Buffer.concat([
        Buffer.from("first\n"),
        Buffer.alloc(100_000, 0x61),
        Buffer.from([0xff]),
      ]),
    );
    const result = await createReadTool().execute(
      { file_path: "tail.txt", limit: 1 },
      context,
    );
    expect(result.output).toContain("1: first");
  });

  it("rechecks permissions on cursor requests", async () => {
    await writeFile(tempRoot, "permission.txt", "a\nb");
    const context = createTestContext(tempRoot);
    const first = await createReadTool().execute(
      { file_path: "permission.txt", limit: 1 },
      context,
    );
    context.resolvePathForExisting = (): Promise<string> =>
      Promise.reject(new Error("Permission denied"));
    await expect(
      createReadTool().execute(
        { file_path: "permission.txt", cursor: first.metadata?.nextCursor },
        context,
      ),
    ).rejects.toThrow("Permission denied");
  });

  it("rejects replacement during a read and releases the actual handle", async () => {
    await writeFile(tempRoot, "race.txt", "a\nb");
    await writeFile(tempRoot, "replacement.txt", "c\nd");
    const originalOpen = fs.open.bind(fs);
    let opened: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      opened = handle;
      const originalRead = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementationOnce(
        async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await originalRead(...readArgs);
          await fs.rename(
            path.join(tempRoot, "replacement.txt"),
            path.join(tempRoot, "race.txt"),
          );
          return result;
        },
      );
      return handle;
    });
    await expect(
      createReadTool().execute(
        { file_path: "race.txt" },
        createTestContext(tempRoot),
      ),
    ).rejects.toThrow(/File has changed/u);
    expect(opened?.fd).toBe(-1);
  });

  it("yields during a long offset scan so cancellation releases the actual handle", async () => {
    await writeFile(tempRoot, "cancel.txt", "x".repeat(2_000_000) + "\nend");
    const originalOpen = fs.open.bind(fs);
    const controller = new AbortController();
    let opened: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      opened = handle;
      const originalRead = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementationOnce(
        async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await originalRead(...readArgs);
          setImmediate(() => {
            controller.abort();
          });
          return result;
        },
      );
      return handle;
    });
    await expect(
      createReadTool().execute(
        { file_path: "cancel.txt", offset: 2 },
        { ...createTestContext(tempRoot), signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(opened?.fd).toBe(-1);
  });
  it("returns the exact numeric filesystem mtime accepted by Write/Edit", async () => {
    await writeFile(tempRoot, "mtime.txt", "a");
    const file = path.join(tempRoot, "mtime.txt");
    await fs.utimes(file, 1700000000, 1700000000.000002);
    const result = await createReadTool().execute(
      { file_path: "mtime.txt" },
      createTestContext(tempRoot),
    );
    expect(result.metadata?.mtimeMs).toBe((await fs.stat(file)).mtimeMs);
  });

  it("bounds scanning for unreachable offsets", async () => {
    await writeFile(tempRoot, "scan.txt", "x".repeat(64 * 1024 * 1024 + 1));
    await expect(
      createReadTool().execute(
        { file_path: "scan.txt", offset: 2 },
        createTestContext(tempRoot),
      ),
    ).rejects.toThrow(/scan limit/iu);
  });
  it("performs bounded reads for small ranges and seeks directly on continuation", async () => {
    await writeFile(tempRoot, "bounded.txt", "a\n" + "x".repeat(1_500_000));
    const originalOpen = fs.open.bind(fs);
    const reads: { position: number; bytes: number }[] = [];
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const originalRead = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(
        async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await originalRead(...readArgs);
          const position = (readArgs as unknown[])[3];
          if (typeof position === "number")
            reads.push({ position, bytes: result.bytesRead });
          return result;
        },
      );
      return handle;
    });
    const context = createTestContext(tempRoot);
    const first = await createReadTool().execute(
      { file_path: "bounded.txt", limit: 1 },
      context,
    );
    expect(first.output).toContain("1: a");
    expect(
      reads.reduce((sum, read) => sum + read.bytes, 0),
    ).toBeLessThanOrEqual(16384);
    const second = await createReadTool().execute(
      { file_path: "bounded.txt", cursor: first.metadata?.nextCursor },
      context,
    );
    reads.length = 0;
    await createReadTool().execute(
      { file_path: "bounded.txt", cursor: second.metadata?.nextCursor },
      context,
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((read) => read.position > 40_000)).toBe(true);
    expect(reads.reduce((sum, read) => sum + read.bytes, 0)).toBeLessThan(
      70_000,
    );
  });
  it.skipIf(process.platform === "win32").each(["existing", "replacement"])(
    "rejects a FIFO (%s) without waiting for a writer",
    async (kind) => {
      const target = path.join(tempRoot, "fifo.txt");
      const fifo =
        kind === "existing" ? target : path.join(tempRoot, "replacement.fifo");
      await promisify(execFile)("mkfifo", [fifo]);
      const originalOpen = fs.open.bind(fs);
      if (kind === "replacement") {
        await fs.writeFile(target, "regular text");
        vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
          await fs.rename(fifo, target);
          return originalOpen(...args);
        });
      }
      const operation = Promise.resolve(
        createReadTool().execute(
          { file_path: "fifo.txt" },
          createTestContext(tempRoot),
        ),
      ).then(
        () => ({ kind: "success", message: "" }),
        (error: unknown) => ({
          kind: "error",
          message: error instanceof Error ? error.message : "unknown error",
        }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        operation,
        new Promise<{ kind: string; message: string }>((resolve) => {
          timer = setTimeout(() => {
            resolve({
              kind: "timeout",
              message: "Read blocked waiting for a FIFO writer",
            });
          }, 150);
        }),
      ]);
      clearTimeout(timer);
      // Rescue a regressed blocking open before assertion so the RED run cannot leak a worker/handle.
      if (outcome.kind === "timeout") {
        const writer = await originalOpen(target, "r+");
        try {
          await operation;
        } finally {
          await writer.close();
        }
      }
      expect(outcome.kind, outcome.message).toBe("error");
      expect(outcome.message).toMatch(/not a file/iu);
    },
  );
});
