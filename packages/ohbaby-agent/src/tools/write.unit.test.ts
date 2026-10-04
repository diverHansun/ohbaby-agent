import * as diffOutput from "./utils/output.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../core/tool-scheduler/index.js";
import { createWriteTool } from "./write.js";

interface TestContext extends ToolExecutionContext {
  writeCalls: number;
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
    messageId: "message_1",
    sessionId: "session_1",
    signal: new AbortController().signal,
    writeCalls: 0,
    resolvePath(inputPath: string): string {
      const resolved = path.resolve(root, inputPath);
      assertInside(root, resolved);
      return resolved;
    },
    async resolvePathForExisting(inputPath: string): Promise<string> {
      const resolved = await fs.realpath(path.resolve(root, inputPath));
      assertInside(root, resolved);
      return resolved;
    },
    async resolvePathForWrite(inputPath: string): Promise<string> {
      this.writeCalls += 1;
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
  content: string,
): Promise<string> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return target;
}

async function statMtimeMs(filePath: string): Promise<number> {
  return (await fs.stat(filePath)).mtimeMs;
}

describe("write file tool", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-write-tool-")),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("commits successfully when the optional diff calculation fails", async () => {
    await writeFile(tempRoot, "note.txt", "old\n");
    vi.spyOn(diffOutput, "renderUnifiedDiff").mockImplementation(() => {
      throw new Error("diff failed");
    });
    const result = await createWriteTool().execute(
      {
        file_path: "note.txt",
        content: "new\n",
        expected_mtime_ms: await statMtimeMs(path.join(tempRoot, "note.txt")),
      },
      createTestContext(tempRoot),
    );
    expect(result.metadata).toMatchObject({
      created: false,
      diffOmitted: true,
      diffOmissionReason: "diff calculation unavailable",
    });
    expect(await fs.readFile(path.join(tempRoot, "note.txt"), "utf8")).toBe(
      "new\n",
    );
  });

  it("saves an honest omitted diff when replacing binary contents", async () => {
    await fs.writeFile(path.join(tempRoot, "note.txt"), Buffer.from([0, 255]));
    const result = await createWriteTool().execute(
      {
        file_path: "note.txt",
        content: "new\n",
        expected_mtime_ms: await statMtimeMs(path.join(tempRoot, "note.txt")),
      },
      createTestContext(tempRoot),
    );
    expect(result.metadata).toMatchObject({
      created: false,
      diffOmitted: true,
      diffOmissionReason: "old contents are binary",
    });
    expect(await fs.readFile(path.join(tempRoot, "note.txt"), "utf8")).toBe(
      "new\n",
    );
  });

  it("creates parent directories and writes new files without an mtime precondition", async () => {
    const context = createTestContext(tempRoot);

    const result = await createWriteTool().execute(
      { content: "hello\n", file_path: "drafts/note.txt" },
      context,
    );

    await expect(
      fs.readFile(path.join(tempRoot, "drafts", "note.txt"), "utf8"),
    ).resolves.toBe("hello\n");
    expect(result.output).toContain("Wrote");
    expect(result.metadata).toMatchObject({
      bytes: Buffer.byteLength("hello\n"),
      created: true,
      diffOmitted: false,
      encoding: "utf8",
      lineEnding: "LF",
    });
    expect(result.metadata?.diff).toContain("+hello");
    expect(result.metadata?.mtimeMs).toEqual(expect.any(Number));
  });

  it("previews new files with dry_run unified diff without writing to disk", async () => {
    const context = createTestContext(tempRoot);

    const result = await createWriteTool().execute(
      {
        content: "hello\nworld\n",
        dry_run: true,
        file_path: "drafts/preview.txt",
      },
      context,
    );

    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
    expect(result.output).toContain("Dry run: no changes written.");
    expect(result.output).toContain("--- before");
    expect(result.output).toContain("+++ after");
    expect(result.output).toContain("@@ -0,0 +1,2 @@");
    expect(result.output).toContain("+hello");
    expect(result.metadata).toMatchObject({
      created: true,
      dryRun: true,
      wouldCreate: true,
    });
    expect(result.metadata?.diff).toEqual(
      expect.stringContaining("@@ -0,0 +1,2 @@"),
    );
  });

  it("supports absolute paths inside the workspace and creates missing directories", async () => {
    const context = createTestContext(tempRoot);
    const absolutePath = path.join(tempRoot, "absolute", "note.txt");

    await createWriteTool().execute(
      { content: "absolute\n", file_path: absolutePath },
      context,
    );

    await expect(fs.readFile(absolutePath, "utf8")).resolves.toBe("absolute\n");
  });

  it("requires expected_mtime_ms before overwriting an existing file", async () => {
    const target = await writeFile(tempRoot, "note.txt", "old\n");
    const context = createTestContext(tempRoot);

    await expect(
      createWriteTool().execute(
        { content: "new\n", file_path: "note.txt" },
        context,
      ),
    ).rejects.toThrow("expected_mtime_ms is required");

    await expect(fs.readFile(target, "utf8")).resolves.toBe("old\n");
  });

  it("rejects stale mtime values without changing the file", async () => {
    const target = await writeFile(tempRoot, "note.txt", "old\n");
    const context = createTestContext(tempRoot);

    await expect(
      createWriteTool().execute(
        { content: "new\n", expected_mtime_ms: 1, file_path: "note.txt" },
        context,
      ),
    ).rejects.toThrow("mtime");

    await expect(fs.readFile(target, "utf8")).resolves.toBe("old\n");
  });

  it("overwrites when mtime matches while preserving an existing UTF-8 BOM", async () => {
    const target = await writeFile(tempRoot, "note.txt", "\uFEFFold\n");
    const mtimeMs = await statMtimeMs(target);
    const context = createTestContext(tempRoot);

    const result = await createWriteTool().execute(
      {
        content: "new\r\ntext\n",
        expected_mtime_ms: mtimeMs,
        file_path: "note.txt",
      },
      context,
    );

    await expect(fs.readFile(target, "utf8")).resolves.toBe(
      "\uFEFFnew\r\ntext\n",
    );
    expect(result.metadata).toMatchObject({
      created: false,
      diffOmitted: false,
      encoding: "utf8",
    });
    expect(result.metadata?.diff).toContain("-old");
  });

  it("previews overwrites with dry_run and a matching mtime without modifying content", async () => {
    const target = await writeFile(tempRoot, "note.txt", "old\n");
    const mtimeMs = await statMtimeMs(target);
    const context = createTestContext(tempRoot);

    const result = await createWriteTool().execute(
      {
        content: "new\n",
        dry_run: true,
        expected_mtime_ms: mtimeMs,
        file_path: "note.txt",
      },
      context,
    );

    await expect(fs.readFile(target, "utf8")).resolves.toBe("old\n");
    expect(result.output).toContain("Dry run: no changes written.");
    expect(result.output).toContain("@@ -1,1 +1,1 @@");
    expect(result.output).toContain("-old");
    expect(result.output).toContain("+new");
    expect(result.metadata).toMatchObject({
      created: false,
      dryRun: true,
      wouldCreate: false,
    });
  });

  it("serializes concurrent overwrites so stale mtime values are rejected", async () => {
    const target = await writeFile(tempRoot, "note.txt", "old\n");
    const mtimeMs = await statMtimeMs(target);
    const context = createTestContext(tempRoot);
    const write = createWriteTool();
    const actualRename = fs.rename.bind(fs);
    let releaseFirstRename!: () => void;
    let firstRenameStarted!: () => void;
    const releaseFirstRenamePromise = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    const firstRenameStartedPromise = new Promise<void>((resolve) => {
      firstRenameStarted = resolve;
    });
    let renameCount = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      renameCount += 1;
      if (renameCount === 1) {
        firstRenameStarted();
        await releaseFirstRenamePromise;
      }
      await actualRename(...args);
    });

    const first = write.execute(
      {
        content: "first\n",
        expected_mtime_ms: mtimeMs,
        file_path: "note.txt",
      },
      context,
    );
    await firstRenameStartedPromise;
    const second = write.execute(
      {
        content: "second\n",
        expected_mtime_ms: mtimeMs,
        file_path: "note.txt",
      },
      context,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseFirstRename();
    const results = await Promise.allSettled([first, second]);

    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    if (results[1].status === "rejected") {
      expect(results[1].reason).toBeInstanceOf(Error);
      expect((results[1].reason as Error).message).toContain("mtime");
    }
    await expect(fs.readFile(target, "utf8")).resolves.toBe("first\n");
  });

  it("cleans up the same-directory temporary file when atomic rename fails", async () => {
    const context = createTestContext(tempRoot);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));

    await expect(
      createWriteTool().execute(
        { content: "hello\n", file_path: "note.txt" },
        context,
      ),
    ).rejects.toThrow("rename failed");

    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
  });
  it.each([
    Buffer.from([255, 254, 97, 0]),
    Buffer.from([97, 0, 98]),
    Buffer.from([255]),
  ])("fully replaces non-text old bytes %j", async (bytes) => {
    const target = path.join(tempRoot, "old.bin");
    await fs.writeFile(target, bytes);
    const result = await createWriteTool().execute(
      {
        file_path: "old.bin",
        content: "new",
        expected_mtime_ms: await statMtimeMs(target),
      },
      createTestContext(tempRoot),
    );
    expect(await fs.readFile(target, "utf8")).toBe("new");
    expect(result.metadata?.created).toBe(false);
  });

  it("previews invalid old UTF-8 as unavailable, never as creation", async () => {
    const target = path.join(tempRoot, "invalid.txt");
    await fs.writeFile(target, Buffer.from([255]));
    const result = await createWriteTool().execute(
      {
        file_path: "invalid.txt",
        content: "new",
        dry_run: true,
        expected_mtime_ms: await statMtimeMs(target),
      },
      createTestContext(tempRoot),
    );
    expect(result.metadata).toMatchObject({
      created: false,
      diffOmitted: true,
    });
    expect(result.output).toContain("Diff omitted");
    expect(await fs.readFile(target)).toEqual(Buffer.from([255]));
  });

  it.each([false, true])(
    "rejects oversized write content before creating or changing target (existing=%s)",
    async (existing) => {
      const target = path.join(tempRoot, "budget.txt");
      if (existing) await fs.writeFile(target, "old");
      await expect(
        createWriteTool().execute(
          {
            file_path: "budget.txt",
            content: "x".repeat(20 * 1024 * 1024 + 1),
            expected_mtime_ms: existing ? await statMtimeMs(target) : undefined,
          },
          createTestContext(tempRoot),
        ),
      ).rejects.toThrow("Write content budget");
      if (existing) expect(await fs.readFile(target, "utf8")).toBe("old");
      else
        await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("honors cancellation before rename and removes temporary files", async () => {
    const target = await writeFile(tempRoot, "cancel.txt", "old");
    const controller = new AbortController();
    const actualChmod = fs.chmod.bind(fs);
    vi.spyOn(fs, "chmod").mockImplementation(async (...args) => {
      await actualChmod(...args);
      controller.abort();
    });
    await expect(
      createWriteTool().execute(
        {
          file_path: "cancel.txt",
          content: "new",
          expected_mtime_ms: await statMtimeMs(target),
        },
        { ...createTestContext(tempRoot), signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("old");
    expect(await fs.readdir(tempRoot)).toEqual(["cancel.txt"]);
  });

  it("checks write permission during dry run", async () => {
    const context = createTestContext(tempRoot);
    context.resolvePathForWrite = (): Promise<string> =>
      Promise.reject(new Error("write denied"));
    await expect(
      createWriteTool().execute(
        { file_path: "new.txt", content: "x", dry_run: true },
        context,
      ),
    ).rejects.toThrow("write denied");
    expect(await fs.readdir(tempRoot)).toEqual([]);
  });
  it("includes an existing BOM in the write limit", async () => {
    const target = await writeFile(tempRoot, "bom.txt", "\uFEFFold");
    await expect(
      createWriteTool().execute(
        {
          file_path: "bom.txt",
          content: "x".repeat(20 * 1024 * 1024),
          expected_mtime_ms: await statMtimeMs(target),
        },
        createTestContext(tempRoot),
      ),
    ).rejects.toThrow("Write content budget");
    expect(await fs.readFile(target, "utf8")).toBe("\uFEFFold");
  });

  it("overwrites a large old file using only its header for normal writes", async () => {
    const target = await writeFile(
      tempRoot,
      "large.txt",
      "a".repeat(21 * 1024 * 1024),
    );
    const readFile = vi.spyOn(fs, "readFile");
    const result = await createWriteTool().execute(
      {
        file_path: "large.txt",
        content: "new",
        expected_mtime_ms: await statMtimeMs(target),
      },
      createTestContext(tempRoot),
    );
    expect(readFile).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({ created: false, bytes: 3 });
    expect(await fs.readFile(target, "utf8")).toBe("new");
  });

  it("reports success when cancellation arrives after atomic rename", async () => {
    const target = await writeFile(tempRoot, "committed.txt", "old");
    const controller = new AbortController();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      await rename(...args);
      controller.abort();
    });
    const result = await createWriteTool().execute(
      {
        file_path: "committed.txt",
        content: "new",
        expected_mtime_ms: await statMtimeMs(target),
      },
      { ...createTestContext(tempRoot), signal: controller.signal },
    );
    expect(result.output).toContain("Wrote");
    expect(await fs.readFile(target, "utf8")).toBe("new");
  });

  it("does not modify a pre-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createWriteTool().execute(
        { file_path: "new.txt", content: "new" },
        { ...createTestContext(tempRoot), signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(await fs.readdir(tempRoot)).toEqual([]);
  });
  it("reports a committed change when post-rename metadata cannot be read", async () => {
    const target = await writeFile(tempRoot, "metadata.txt", "old");
    const mtime = (await fs.stat(target)).mtimeMs;
    let committed = false;
    const rename = fs.rename.bind(fs);
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      await rename(...args);
      committed = true;
    });
    vi.spyOn(fs, "stat").mockImplementation((...args) => {
      if (committed) return Promise.reject(new Error("metadata unavailable"));
      return stat(...args);
    });
    const result = await createWriteTool().execute(
      { file_path: "metadata.txt", content: "new", expected_mtime_ms: mtime },
      createTestContext(tempRoot),
    );
    expect(result.output).toContain("metadata unavailable");
    expect(result.metadata).toMatchObject({
      sizeBytes: 3,
    });
    expect(typeof result.metadata?.metadataWarning).toBe("string");
    expect(result.metadata?.mtimeMs).toBeUndefined();
    expect(await fs.readFile(target, "utf8")).toBe("new");
  });
  it.each(["\uD83D", "\uDE00"])(
    "rejects malformed Unicode content %j without creating a target",
    async (content) => {
      await expect(
        createWriteTool().execute(
          { file_path: "invalid.txt", content },
          createTestContext(tempRoot),
        ),
      ).rejects.toThrow("well-formed Unicode");
      expect(await fs.readdir(tempRoot)).toEqual([]);
    },
  );
});
