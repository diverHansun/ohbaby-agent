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
      encoding: "utf8",
      lineEnding: "LF",
    });
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
      encoding: "utf8",
    });
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
});
