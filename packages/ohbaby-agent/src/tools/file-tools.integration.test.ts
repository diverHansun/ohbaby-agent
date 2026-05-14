import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../core/tool-scheduler/index.js";
import { createBuiltinTools } from "./index.js";

interface TestContext extends ToolExecutionContext {
  existingCalls: number;
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
    existingCalls: 0,
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
      this.existingCalls += 1;
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

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

function tool(name: string): ReturnType<typeof createBuiltinTools>[number] {
  const found = createBuiltinTools().find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`Tool not found in test: ${name}`);
  }
  return found;
}

describe("file builtin tools", () => {
  let tempRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-tools-")),
    );
    outsideRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-outside-")),
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
    await fs.rm(outsideRoot, { force: true, recursive: true });
  });

  it("reads line ranges through the execution context", async () => {
    await writeFile(tempRoot, "notes.txt", "alpha\nbeta\ngamma\ndelta\n");
    const context = createTestContext(tempRoot);

    const result = await tool("read").execute(
      { file_path: "notes.txt", limit: 2, offset: 2 },
      context,
    );

    expect(context.existingCalls).toBeGreaterThan(0);
    expect(result.output).toContain("2: beta");
    expect(result.output).toContain("3: gamma");
    expect(result.output).not.toContain("1: alpha");
    expect(result.metadata).toMatchObject({ lineCount: 4 });
  });

  it("rejects path escapes before reading", async () => {
    await writeFile(outsideRoot, "secret.txt", "secret");
    const context = createTestContext(tempRoot);

    await expect(
      tool("read").execute(
        { file_path: path.relative(tempRoot, path.join(outsideRoot, "secret.txt")) },
        context,
      ),
    ).rejects.toThrow("escapes workspace");
    expect(context.existingCalls).toBeGreaterThan(0);
  });

  it("lists, globs, and greps bounded workspace content", async () => {
    await writeFile(tempRoot, "src/a.ts", "export const alpha = 1;\n");
    await writeFile(tempRoot, "src/b.js", "const beta = 2;\n");
    await writeFile(tempRoot, "node_modules/hidden.ts", "alpha\n");
    const context = createTestContext(tempRoot);

    const list = await tool("list").execute({ path: "." }, context);
    const glob = await tool("glob").execute({ pattern: "**/*.ts" }, context);
    const grep = await tool("grep").execute(
      { include: "**/*.ts", pattern: "alpha" },
      context,
    );

    expect(list.output).toContain("src/");
    expect(list.output).not.toContain("node_modules");
    expect(glob.output).toContain("src/a.ts");
    expect(glob.output).not.toContain("node_modules/hidden.ts");
    expect(grep.output).toContain("src/a.ts:1: export const alpha = 1;");
    expect(context.existingCalls).toBeGreaterThanOrEqual(3);
  });

  it("continues glob scanning until it reaches matching results", async () => {
    for (let index = 0; index < 10; index += 1) {
      await writeFile(tempRoot, `src/${String(index).padStart(2, "0")}.js`, "noop\n");
    }
    await writeFile(tempRoot, "src/z-target.ts", "export const target = true;\n");
    const context = createTestContext(tempRoot);

    const result = await tool("glob").execute(
      { limit: 1, pattern: "**/*.ts" },
      context,
    );

    expect(result.output).toContain("src/z-target.ts");
    expect(result.metadata).toMatchObject({ count: 1 });
  });

  it("refuses oversized reads before loading content", async () => {
    await writeFile(tempRoot, "large.txt", "x".repeat(1_000_001));
    const context = createTestContext(tempRoot);

    await expect(
      tool("read").execute({ file_path: "large.txt" }, context),
    ).rejects.toThrow("File is too large to read");
  });

  it("skips oversized files while grepping", async () => {
    await writeFile(tempRoot, "large.txt", `${"x".repeat(1_000_001)}needle\n`);
    await writeFile(tempRoot, "small.txt", "nothing here\n");
    const context = createTestContext(tempRoot);

    const result = await tool("grep").execute(
      { pattern: "needle" },
      context,
    );

    expect(result.output).toBe("No matches found.");
    expect(result.metadata).toMatchObject({ skippedLargeFiles: 1 });
  });

  it("writes and edits files through write path resolution", async () => {
    const context = createTestContext(tempRoot);

    const write = await tool("write").execute(
      { content: "hello world\n", file_path: "drafts/note.txt" },
      context,
    );
    const edit = await tool("edit").execute(
      {
        file_path: "drafts/note.txt",
        new_string: "hello tools",
        old_string: "hello world",
      },
      context,
    );

    await expect(
      fs.readFile(path.join(tempRoot, "drafts", "note.txt"), "utf8"),
    ).resolves.toBe("hello tools\n");
    expect(write.output).toContain("Wrote");
    expect(edit.output).toContain("Replacements: 1");
    expect(edit.output).toContain("-hello world");
    expect(edit.output).toContain("+hello tools");
    expect(context.writeCalls).toBeGreaterThanOrEqual(2);
  });

  it("truncates large edit diffs", async () => {
    const oldString = "old".repeat(12_000);
    const newString = "new".repeat(12_000);
    await writeFile(tempRoot, "large-edit.txt", `${oldString}\n`);
    const context = createTestContext(tempRoot);

    const result = await tool("edit").execute(
      {
        file_path: "large-edit.txt",
        new_string: newString,
        old_string: oldString,
      },
      context,
    );

    expect(result.output).toContain("[results truncated]");
  });

  it("fails invalid edits without modifying the file", async () => {
    await writeFile(tempRoot, "target.txt", "unchanged\n");
    const context = createTestContext(tempRoot);

    await expect(
      tool("edit").execute(
        {
          file_path: "target.txt",
          new_string: "after",
          old_string: "missing",
        },
        context,
      ),
    ).rejects.toThrow("No occurrences found");
    await expect(fs.readFile(path.join(tempRoot, "target.txt"), "utf8")).resolves.toBe(
      "unchanged\n",
    );
  });
});
