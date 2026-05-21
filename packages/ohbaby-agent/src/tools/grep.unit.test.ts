import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../core/tool-scheduler/index.js";
import { createGrepTool } from "./grep.js";

interface TestContext extends ToolExecutionContext {
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

describe("grep file tool", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-grep-tool-")),
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("searches included text files with line numbers", async () => {
    await writeFile(tempRoot, "src/a.ts", "export const alpha = 1;\n");
    await writeFile(tempRoot, "src/b.js", "const alpha = 2;\n");
    const context = createTestContext(tempRoot);

    const result = await createGrepTool().execute(
      { include: "**/*.ts", pattern: "alpha" },
      context,
    );

    expect(result.output).toContain("src/a.ts:1: export const alpha = 1;");
    expect(result.output).not.toContain("src/b.js");
    expect(result.metadata).toMatchObject({ count: 1, truncated: false });
  });

  it("skips oversized and binary files", async () => {
    await writeFile(tempRoot, "large.txt", `${"x".repeat(1_000_001)}needle\n`);
    await writeFile(tempRoot, "binary.png", "needle\n");
    await writeFile(tempRoot, "sample.txt", Buffer.from([0x61, 0x00, 0x62]));
    const context = createTestContext(tempRoot);

    const result = await createGrepTool().execute({ pattern: "needle" }, context);

    expect(result.output).toBe("No matches found.");
    expect(result.metadata).toMatchObject({
      skippedBinaryFiles: 2,
      skippedLargeFiles: 1,
    });
  });
});
