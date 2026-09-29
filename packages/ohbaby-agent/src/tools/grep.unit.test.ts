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
    await writeFile(tempRoot, path.join("src", "b.js"), "const alpha = 2;\n");
    const context = createTestContext(tempRoot);

    const result = await createGrepTool().execute(
      { include: "**/*.ts", pattern: "alpha" },
      context,
    );

    expect(result.output).toContain(
      `${path.join("src", "a.ts")}:1: export const alpha = 1;`,
    );
    expect(result.output).not.toContain(path.join("src", "b.js"));
    expect(result.metadata).toMatchObject({ count: 1, truncated: false });
  });

  it("searches large files and previews a late match on a long UTF-8 line", async () => {
    await writeFile(tempRoot, "large.txt", `${"界".repeat(400_000)}needle尾\n`);
    const result = await createGrepTool().execute(
      { pattern: "needle" },
      createTestContext(tempRoot),
    );
    expect(result.output).toContain("large.txt:1:");
    expect(result.output).toContain("needle尾");
    expect(result.output).toContain("preview omitted");
    expect(Buffer.byteLength(result.output ?? "")).toBeLessThan(2500);
    expect(result.output).not.toContain("�");
    expect(result.metadata).toMatchObject({
      count: 1,
      scanComplete: true,
      displayLimited: true,
    });
  });

  it("only reports no matches after completing the scoped search", async () => {
    await writeFile(tempRoot, "a.txt", "nothing here\n");
    const result = await createGrepTool().execute(
      { pattern: "needle" },
      createTestContext(tempRoot),
    );
    expect(result.output).toContain("No matches found");
    expect(result.metadata).toMatchObject({ count: 0, scanComplete: true });
  });

  it("honors project ignores, hidden files, include overrides and .git exclusion", async () => {
    await writeFile(tempRoot, ".gitignore", "ignored.txt\n");
    await writeFile(tempRoot, ".git/config", "needle\n");
    await writeFile(tempRoot, "ignored.txt", "needle\n");
    await writeFile(tempRoot, ".hidden", "needle\n");
    await writeFile(tempRoot, "dist/out.txt", "needle\n");
    const tool = createGrepTool();
    const context = createTestContext(tempRoot);
    const result = await tool.execute({ pattern: "needle" }, context);
    expect(result.output).toContain(".hidden:1:");
    expect(result.output).toContain(`${path.join("dist", "out.txt")}:1:`);
    expect(result.output).not.toContain("ignored.txt:1:");
    expect(result.output).not.toContain(`${path.join(".git", "config")}:1:`);
    const included = await tool.execute(
      { pattern: "needle", include: "**/*" },
      context,
    );
    expect(included.output).toContain("ignored.txt:1:");
    expect(included.output).not.toContain(`${path.join(".git", "config")}:1:`);
    const explicit = await tool.execute(
      { pattern: "needle", path: "ignored.txt", include: "*.ts" },
      context,
    );
    expect(explicit.output).toContain("ignored.txt:1:");
    const gitFile = await tool.execute(
      { pattern: "needle", path: ".git/config" },
      context,
    );
    expect(gitFile.output).toContain("config:1:");
  });

  it.each(["(?<=a)b", "(a)\\1", "["])(
    "rejects unsupported or invalid rg expression %s",
    async (pattern) => {
      await writeFile(tempRoot, "a.txt", "aab\n");
      await expect(
        createGrepTool().execute({ pattern }, createTestContext(tempRoot)),
      ).rejects.toThrow(/search failed/i);
    },
  );

  it("treats pattern and include as argv and rejects invalid globs", async () => {
    await writeFile(tempRoot, "a.txt", "--hello;$(touch nope)\n");
    const result = await createGrepTool().execute(
      { pattern: "--hello" },
      createTestContext(tempRoot),
    );
    expect(result.output).toContain("--hello");
    await expect(
      createGrepTool().execute(
        { pattern: "hello", include: "[" },
        createTestContext(tempRoot),
      ),
    ).rejects.toThrow(/search failed/i);
    await expect(fs.stat(path.join(tempRoot, "nope"))).rejects.toThrow();
  });

  it("counts matching lines, stops at limit without claiming more exist", async () => {
    await writeFile(tempRoot, "a.txt", "needle needle\nneedle\nneedle\n");
    const result = await createGrepTool().execute(
      { pattern: "needle", limit: 1 },
      createTestContext(tempRoot),
    );
    expect(result.metadata).toMatchObject({
      count: 1,
      scanComplete: false,
      stopReason: "match-limit",
    });
    expect(result.output).toContain("Search incomplete");
    expect(result.output).toContain("not confirmed");
    expect(result.output).toContain("Narrow path/include/pattern");
    expect(result.output).not.toContain("a.txt:2:");
  });

  it("caps the full output including limitation notice", async () => {
    await writeFile(
      tempRoot,
      "a.txt",
      `${"needle" + "界".repeat(1000)}\n`.repeat(100),
    );
    const result = await createGrepTool().execute(
      { pattern: "needle" },
      createTestContext(tempRoot),
    );
    expect(Buffer.byteLength(result.output ?? "")).toBeLessThanOrEqual(51_200);
    expect(result.output).toContain("Search incomplete");
    expect(result.metadata).toMatchObject({
      scanComplete: false,
      stopReason: "output-limit",
    });
  });

  it("does not turn a pre-aborted execution into a successful empty search", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Search cancelled by caller"));
    await expect(
      createGrepTool().execute(
        { pattern: "x" },
        { ...createTestContext(tempRoot), signal: controller.signal },
      ),
    ).rejects.toThrow(/cancel/i);
  });
  it("reports binary suppression and keeps invalid UTF-8 match locations", async () => {
    await writeFile(tempRoot, "binary.txt", Buffer.from("needle\0tail\n"));
    const binary = await createGrepTool().execute(
      { pattern: "needle", path: "binary.txt" },
      createTestContext(tempRoot),
    );
    expect(binary.output).toContain("binary detection");
    expect(binary.metadata).toMatchObject({ scanComplete: false });
    await writeFile(
      tempRoot,
      "bad.txt",
      Buffer.concat([
        Buffer.from("needle"),
        Buffer.from([255]),
        Buffer.from("\n"),
      ]),
    );
    const invalid = await createGrepTool().execute(
      { pattern: "needle", path: "bad.txt" },
      createTestContext(tempRoot),
    );
    expect(invalid.output).toContain(
      "bad.txt:1: Preview unavailable: matched line is not valid UTF-8.",
    );
    expect(invalid.output).not.toContain("�");
    expect(invalid.metadata).toMatchObject({
      count: 1,
      scanComplete: true,
      displayLimited: true,
    });
  });

  it("uses rg native UTF-16 BOM decoding", async () => {
    await writeFile(
      tempRoot,
      "utf16.txt",
      Buffer.concat([
        Buffer.from([255, 254]),
        Buffer.from("needle\n", "utf16le"),
      ]),
    );
    const result = await createGrepTool().execute(
      { pattern: "needle" },
      createTestContext(tempRoot),
    );
    expect(result.output).toContain("utf16.txt:1: needle");
  });

  it("reports a raw record budget stop even when no match could be delivered", async () => {
    await writeFile(
      tempRoot,
      "huge.txt",
      `${"a".repeat(5 * 1024 * 1024)}needle\n`,
    );
    const result = await createGrepTool().execute(
      { pattern: "needle" },
      createTestContext(tempRoot),
    );
    expect(result.output).toContain("Search incomplete");
    expect(result.output).toContain("record");
    expect(result.output).toContain(
      "No matching locations were returned from the scanned portion",
    );
    expect(result.metadata).toMatchObject({
      count: 0,
      scanComplete: false,
      stopReason: "record-limit",
    });
  });

  it("honors .gitignore even in a project without a git repository", async () => {
    await writeFile(tempRoot, ".gitignore", "ignored.txt\n");
    await writeFile(tempRoot, "ignored.txt", "needle\n");
    await writeFile(tempRoot, "plain.txt", "nothing\n");
    const result = await createGrepTool().execute(
      { pattern: "needle" },
      createTestContext(tempRoot),
    );
    expect(result.output).not.toContain("ignored.txt:1:");
    expect(result.metadata).toMatchObject({ count: 0, scanComplete: true });
  });
  it("defaults to 100 matching lines and treats an exact limit as unconfirmed completeness", async () => {
    await writeFile(tempRoot, "a.txt", "needle\n".repeat(100));
    const result = await createGrepTool().execute(
      { pattern: "needle" },
      createTestContext(tempRoot),
    );
    expect(result.metadata).toMatchObject({
      count: 100,
      scanComplete: false,
      stopReason: "match-limit",
      processExited: true,
    });
    expect(result.output).toContain("not confirmed");
    expect(result.output).not.toContain("more matches exist");
  });

  it("isolates an explicit directory from parent ignores and external rg configuration", async () => {
    await writeFile(tempRoot, ".ignore", "child/\n");
    await writeFile(tempRoot, "child/needle.txt", "needle\n");
    await writeFile(tempRoot, "config", "--glob=!*.txt\n--pcre2\n");
    const previous = process.env.RIPGREP_CONFIG_PATH;
    process.env.RIPGREP_CONFIG_PATH = path.join(tempRoot, "config");
    try {
      const result = await createGrepTool().execute(
        { pattern: "needle", path: "child" },
        createTestContext(tempRoot),
      );
      expect(result.output).toContain(`${path.join("child", "needle.txt")}:1:`);
      await expect(
        createGrepTool().execute(
          { pattern: "(?<=n)eedle", path: "child" },
          createTestContext(tempRoot),
        ),
      ).rejects.toThrow(/search failed/i);
    } finally {
      if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
      else process.env.RIPGREP_CONFIG_PATH = previous;
    }
  });

  it("retains path permission enforcement before starting rg", async () => {
    await expect(
      createGrepTool().execute(
        { pattern: "x", path: ".." },
        createTestContext(tempRoot),
      ),
    ).rejects.toThrow(/escapes workspace/);
  });

  it("searches UTF-8 BOM text and reports directory binary suppression", async () => {
    await writeFile(tempRoot, "bom.txt", "\ufeffneedle\n");
    await writeFile(
      tempRoot,
      "binary.txt",
      Buffer.from("needle\n" + "a\n".repeat(40_000) + "\0tail\n"),
    );
    const result = await createGrepTool().execute(
      { pattern: "needle" },
      createTestContext(tempRoot),
    );
    expect(result.output).toContain("bom.txt:1: needle");
    expect(result.output).toContain("binary detection");
    expect(result.metadata).toMatchObject({
      scanComplete: false,
      binaryFileCount: 1,
    });
  });
});
