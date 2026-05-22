import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    await fs.rm(tempRoot, { force: true, recursive: true });
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
      lineCount: 3,
      lineEnding: "CRLF",
      nextOffset: 3,
      shownLineCount: 2,
    });
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
});
