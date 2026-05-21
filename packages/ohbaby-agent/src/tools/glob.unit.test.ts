import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../core/tool-scheduler/index.js";
import { createGlobTool } from "./glob.js";

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

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

describe("glob file tool", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-glob-tool-")),
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("finds matching files while applying default ignores", async () => {
    await writeFile(tempRoot, "src/a.ts", "export const alpha = 1;\n");
    await writeFile(tempRoot, "src/b.js", "const beta = 2;\n");
    await writeFile(tempRoot, "node_modules/hidden.ts", "alpha\n");
    const context = createTestContext(tempRoot);

    const result = await createGlobTool().execute(
      { pattern: "**/*.ts" },
      context,
    );

    expect(result.output).toContain("src/a.ts");
    expect(result.output).not.toContain("node_modules/hidden.ts");
    expect(result.metadata).toMatchObject({ count: 1, truncated: false });
  });

  it("continues scanning until it reaches matching results", async () => {
    for (let index = 0; index < 10; index += 1) {
      await writeFile(tempRoot, `src/${String(index).padStart(2, "0")}.js`, "noop\n");
    }
    await writeFile(tempRoot, "src/z-target.ts", "export const target = true;\n");
    const context = createTestContext(tempRoot);

    const result = await createGlobTool().execute(
      { limit: 1, pattern: "**/*.ts" },
      context,
    );

    expect(result.output).toContain("src/z-target.ts");
    expect(result.metadata).toMatchObject({ count: 1, truncated: true });
  });
});
