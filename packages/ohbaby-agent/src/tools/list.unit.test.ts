import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../core/tool-scheduler/index.js";
import { createListTool } from "./list.js";

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

describe("list file tool", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-list-tool-")),
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("lists immediate visible entries and applies default ignores", async () => {
    await writeFile(tempRoot, "src/a.ts", "export const alpha = 1;\n");
    await writeFile(tempRoot, "node_modules/hidden.ts", "alpha\n");
    await writeFile(tempRoot, "dist/bundle.js", "hidden\n");
    const context = createTestContext(tempRoot);

    const result = await createListTool().execute({ path: "." }, context);

    expect(result.output).toContain("src/");
    expect(result.output).not.toContain("node_modules");
    expect(result.output).not.toContain("dist");
    expect(result.metadata).toMatchObject({ count: 1, truncated: false });
  });

  it("honors limit and reports truncation", async () => {
    await writeFile(tempRoot, "a.txt", "a\n");
    await writeFile(tempRoot, "b.txt", "b\n");
    await writeFile(tempRoot, "c.txt", "c\n");
    const context = createTestContext(tempRoot);

    const result = await createListTool().execute({ limit: 2, path: "." }, context);

    expect(result.output).toContain("a.txt");
    expect(result.output).toContain("b.txt");
    expect(result.output).toContain("... (1 more entries)");
    expect(result.output).not.toContain("c.txt");
    expect(result.metadata).toMatchObject({ count: 2, truncated: true });
  });
});
