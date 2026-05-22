import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../core/tool-scheduler/index.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";

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

async function readBeforeEdit(
  context: ToolExecutionContext,
  filePath: string,
): Promise<number> {
  const result = await createReadTool().execute(
    { file_path: filePath },
    context,
  );
  const mtimeMs = result.metadata?.mtimeMs;
  if (typeof mtimeMs !== "number") {
    throw new Error("read did not return mtimeMs");
  }

  return mtimeMs;
}

describe("edit file tool", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-edit-tool-")),
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("requires expected_mtime_ms before modifying a file", async () => {
    const target = await writeFile(tempRoot, "note.txt", "old\n");
    const context = createTestContext(tempRoot);

    await expect(
      createEditTool().execute(
        { file_path: "note.txt", new_string: "new", old_string: "old" },
        context,
      ),
    ).rejects.toThrow("expected_mtime_ms is required");

    await expect(fs.readFile(target, "utf8")).resolves.toBe("old\n");
  });

  it("edits a unique match only when mtime matches and preserves CRLF", async () => {
    const target = await writeFile(tempRoot, "note.txt", "alpha\r\nbeta\r\n");
    const context = createTestContext(tempRoot);
    const mtimeMs = await readBeforeEdit(context, "note.txt");

    const result = await createEditTool().execute(
      {
        expected_mtime_ms: mtimeMs,
        file_path: "note.txt",
        new_string: "alpha\nbeta changed",
        old_string: "alpha\nbeta",
      },
      context,
    );

    await expect(fs.readFile(target, "utf8")).resolves.toBe(
      "alpha\r\nbeta changed\r\n",
    );
    expect(result.output).toContain("Replacements: 1");
    expect(result.metadata).toMatchObject({
      encoding: "utf8",
      lineEnding: "CRLF",
      replacementCount: 1,
    });
  });

  it("supports replace_all with a matching mtime", async () => {
    const target = await writeFile(tempRoot, "note.txt", "x\nx\n");
    const context = createTestContext(tempRoot);
    const mtimeMs = await readBeforeEdit(context, "note.txt");

    await createEditTool().execute(
      {
        expected_mtime_ms: mtimeMs,
        file_path: "note.txt",
        new_string: "y",
        old_string: "x",
        replace_all: true,
      },
      context,
    );

    await expect(fs.readFile(target, "utf8")).resolves.toBe("y\ny\n");
  });

  it("requires the file to be read in the same session before edit", async () => {
    const target = await writeFile(tempRoot, "note.txt", "old\n");
    const mtimeMs = await statMtimeMs(target);
    const context = createTestContext(tempRoot);

    await expect(
      createEditTool().execute(
        {
          expected_mtime_ms: mtimeMs,
          file_path: "note.txt",
          new_string: "new",
          old_string: "old",
        },
        context,
      ),
    ).rejects.toThrow("must be read before edit");
    await expect(fs.readFile(target, "utf8")).resolves.toBe("old\n");
  });

  it("previews edits with dry_run unified diff without modifying the file", async () => {
    const target = await writeFile(tempRoot, "note.txt", "old\n");
    const context = createTestContext(tempRoot);
    const mtimeMs = await readBeforeEdit(context, "note.txt");

    const result = await createEditTool().execute(
      {
        dry_run: true,
        expected_mtime_ms: mtimeMs,
        file_path: "note.txt",
        new_string: "new",
        old_string: "old",
      },
      context,
    );

    await expect(fs.readFile(target, "utf8")).resolves.toBe("old\n");
    expect(result.output).toContain("Dry run: no changes written.");
    expect(result.output).toContain("@@ -1,1 +1,1 @@");
    expect(result.output).toContain("-old");
    expect(result.output).toContain("+new");
    expect(result.metadata).toMatchObject({
      dryRun: true,
      replacementCount: 1,
    });
  });

  it("rejects missing, multiple, stale, binary, and oversized edits without changing text files", async () => {
    const target = await writeFile(tempRoot, "note.txt", "same\nsame\n");
    await writeFile(tempRoot, "large.txt", "x".repeat(1_000_001));
    await fs.writeFile(
      path.join(tempRoot, "binary.bin"),
      Buffer.from([0x61, 0x00, 0x62]),
    );
    const context = createTestContext(tempRoot);
    const mtimeMs = await readBeforeEdit(context, "note.txt");
    const edit = createEditTool();

    await expect(
      edit.execute(
        {
          expected_mtime_ms: mtimeMs,
          file_path: "note.txt",
          new_string: "after",
          old_string: "missing",
        },
        context,
      ),
    ).rejects.toThrow("No occurrences found");
    await expect(
      edit.execute(
        {
          expected_mtime_ms: mtimeMs,
          file_path: "note.txt",
          new_string: "once",
          old_string: "same",
        },
        context,
      ),
    ).rejects.toThrow("Multiple occurrences found");
    await expect(
      edit.execute(
        {
          expected_mtime_ms: 1,
          file_path: "note.txt",
          new_string: "once",
          old_string: "same",
          replace_all: true,
        },
        context,
      ),
    ).rejects.toThrow("mtime");
    await expect(
      edit.execute(
        {
          expected_mtime_ms: mtimeMs,
          file_path: "binary.bin",
          new_string: "b",
          old_string: "a",
        },
        context,
      ),
    ).rejects.toThrow("Binary files cannot be read as text");
    await expect(
      edit.execute(
        {
          expected_mtime_ms: mtimeMs,
          file_path: "large.txt",
          new_string: "y",
          old_string: "x",
        },
        context,
      ),
    ).rejects.toThrow("File is too large to read");

    await expect(fs.readFile(target, "utf8")).resolves.toBe("same\nsame\n");
  });
});
