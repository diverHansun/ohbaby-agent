import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../core/tool-scheduler/index.js";
import { createEditTool } from "./edit.js";

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

describe("edit file tool", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-edit-tool-")),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("marks expected_mtime_ms as deprecated compatibility input", () => {
    const schema = createEditTool().parametersJsonSchema as {
      readonly properties: Record<string, Record<string, unknown>>;
    };

    expect(schema.properties.expected_mtime_ms).toMatchObject({
      deprecated: true,
    });
    expect(schema.properties.old_string.description).toEqual(
      expect.stringContaining("Whitespace fuzzy matching"),
    );
  });

  it("allows editing without an expected mtime", async () => {
    const target = await writeFile(tempRoot, "note.txt", "old\n");
    const context = createTestContext(tempRoot);

    await createEditTool().execute(
      { file_path: "note.txt", new_string: "new", old_string: "old" },
      context,
    );

    await expect(fs.readFile(target, "utf8")).resolves.toBe("new\n");
  });

  it("edits a unique match and preserves CRLF", async () => {
    const target = await writeFile(tempRoot, "note.txt", "alpha\r\nbeta\r\n");
    const context = createTestContext(tempRoot);

    const result = await createEditTool().execute(
      {
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

  it("supports replace_all for exact matches", async () => {
    const target = await writeFile(tempRoot, "note.txt", "x\nx\n");
    const context = createTestContext(tempRoot);

    await createEditTool().execute(
      {
        file_path: "note.txt",
        new_string: "y",
        old_string: "x",
        replace_all: true,
      },
      context,
    );

    await expect(fs.readFile(target, "utf8")).resolves.toBe("y\ny\n");
  });

  it("allows consecutive edits without re-reading", async () => {
    const target = await writeFile(tempRoot, "note.txt", "alpha\nbeta\n");
    const context = createTestContext(tempRoot);
    const edit = createEditTool();

    await edit.execute(
      { file_path: "note.txt", new_string: "ALPHA", old_string: "alpha" },
      context,
    );
    await edit.execute(
      { file_path: "note.txt", new_string: "BETA", old_string: "beta" },
      context,
    );

    await expect(fs.readFile(target, "utf8")).resolves.toBe("ALPHA\nBETA\n");
  });

  it("previews edits with dry_run unified diff without modifying the file", async () => {
    const target = await writeFile(tempRoot, "note.txt", "old\n");
    const context = createTestContext(tempRoot);

    const result = await createEditTool().execute(
      {
        dry_run: true,
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

  it("rejects missing, multiple, binary, and oversized edits without changing text files", async () => {
    const target = await writeFile(tempRoot, "note.txt", "same\nsame\n");
    await writeFile(tempRoot, "large.txt", "x".repeat(10 * 1024 * 1024 + 1));
    await fs.writeFile(
      path.join(tempRoot, "binary.bin"),
      Buffer.from([0x61, 0x00, 0x62]),
    );
    const context = createTestContext(tempRoot);
    const edit = createEditTool();

    await expect(
      edit.execute(
        {
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
          file_path: "large.txt",
          new_string: "y",
          old_string: "x",
        },
        context,
      ),
    ).rejects.toThrow("Edit original budget");

    await expect(fs.readFile(target, "utf8")).resolves.toBe("same\nsame\n");
  });

  it("uses bounded fuzzy matching for whitespace-only drift", async () => {
    const target = await writeFile(
      tempRoot,
      "note.txt",
      "  const value = 1;\n  const label = 'ready';\n",
    );
    const context = createTestContext(tempRoot);

    await createEditTool().execute(
      {
        file_path: "note.txt",
        new_string: "  const value = 2;\n  const label = 'ready';",
        old_string: "const value = 1;\nconst label = 'ready';",
      },
      context,
    );

    await expect(fs.readFile(target, "utf8")).resolves.toBe(
      "  const value = 2;\n  const label = 'ready';\n",
    );
  });

  it("rejects fuzzy matches that are not unique", async () => {
    const target = await writeFile(tempRoot, "note.txt", "  value\n\tvalue\n");
    const context = createTestContext(tempRoot);

    await expect(
      createEditTool().execute(
        {
          file_path: "note.txt",
          new_string: "changed",
          old_string: "value",
        },
        context,
      ),
    ).rejects.toThrow("Multiple occurrences found");
    await expect(fs.readFile(target, "utf8")).resolves.toBe(
      "  value\n\tvalue\n",
    );
  });

  it("prefers narrower fuzzy matches before broader whitespace normalization", async () => {
    const target = await writeFile(
      tempRoot,
      "note.txt",
      "  alpha beta\n  guard\nalpha    beta\n  guard\n",
    );
    const context = createTestContext(tempRoot);

    await createEditTool().execute(
      {
        file_path: "note.txt",
        new_string: "  changed\n  guard",
        old_string: "alpha beta\nguard",
      },
      context,
    );

    await expect(fs.readFile(target, "utf8")).resolves.toBe(
      "  changed\n  guard\nalpha    beta\n  guard\n",
    );
  });

  it("serializes concurrent direct edits to preserve both changes", async () => {
    const target = await writeFile(
      tempRoot,
      "note.txt",
      "top = 0\nmiddle = keep\nbottom = 0\n",
    );
    const context = createTestContext(tempRoot);
    const edit = createEditTool();
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

    const first = edit.execute(
      { file_path: "note.txt", new_string: "top = 1", old_string: "top = 0" },
      context,
    );
    await firstRenameStartedPromise;
    const second = edit.execute(
      {
        file_path: "note.txt",
        new_string: "bottom = 2",
        old_string: "bottom = 0",
      },
      context,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseFirstRename();
    await Promise.all([first, second]);

    await expect(fs.readFile(target, "utf8")).resolves.toBe(
      "top = 1\nmiddle = keep\nbottom = 2\n",
    );
  });
  it("rejects invalid UTF-8 without changing original bytes", async () => {
    const target = path.join(tempRoot, "invalid.txt");
    const bytes = Buffer.from([97, 255, 98]);
    await fs.writeFile(target, bytes);
    await expect(
      createEditTool().execute(
        { file_path: "invalid.txt", old_string: "a", new_string: "z" },
        createTestContext(tempRoot),
      ),
    ).rejects.toThrow("UTF-8");
    expect(await fs.readFile(target)).toEqual(bytes);
  });

  it("edits above the former read limit and omits an oversized diff", async () => {
    const original = "a".repeat(1_100_000) + "unique";
    const target = await writeFile(tempRoot, "large.txt", original);
    const result = await createEditTool().execute(
      { file_path: "large.txt", old_string: "unique", new_string: "changed" },
      createTestContext(tempRoot),
    );
    expect(await fs.readFile(target, "utf8")).toBe(
      "a".repeat(1_100_000) + "changed",
    );
    expect(result.metadata?.diffOmitted).toBe(true);
    expect(result.output).toContain("Diff omitted");
  });

  it("rejects batch replacement growth before writing", async () => {
    const target = await writeFile(tempRoot, "grow.txt", "x".repeat(2000));
    await expect(
      createEditTool().execute(
        {
          file_path: "grow.txt",
          old_string: "x",
          new_string: "y".repeat(6000),
          replace_all: true,
        },
        createTestContext(tempRoot),
      ),
    ).rejects.toThrow("Edit result budget");
    expect(await fs.readFile(target, "utf8")).toBe("x".repeat(2000));
  });

  it("rejects fuzzy work above its budget without changing the file", async () => {
    const original = "long line\n".repeat(100_000);
    const target = await writeFile(tempRoot, "fuzzy.txt", original);
    await expect(
      createEditTool().execute(
        { file_path: "fuzzy.txt", old_string: "missing", new_string: "y" },
        createTestContext(tempRoot),
      ),
    ).rejects.toThrow("fuzzy matching budget");
    expect(await fs.readFile(target, "utf8")).toBe(original);
  });
  it("preserves BOM and no final newline for an exact edit", async () => {
    const target = await writeFile(tempRoot, "bom.txt", "\uFEFFold");
    await createEditTool().execute(
      { file_path: "bom.txt", old_string: "old", new_string: "new" },
      createTestContext(tempRoot),
    );
    expect(await fs.readFile(target, "utf8")).toBe("\uFEFFnew");
  });

  it("rejects a single replacement result above the limit without writing", async () => {
    const target = await writeFile(tempRoot, "single.txt", "old suffix");
    await expect(
      createEditTool().execute(
        {
          file_path: "single.txt",
          old_string: "old",
          new_string: "x".repeat(10 * 1024 * 1024),
        },
        createTestContext(tempRoot),
      ),
    ).rejects.toThrow("Edit result budget");
    expect(await fs.readFile(target, "utf8")).toBe("old suffix");
  });

  it("omits large output previews in metadata and keeps dry-run content intact", async () => {
    const original = "a".repeat(20_000) + "old";
    const target = await writeFile(tempRoot, "preview.txt", original);
    const result = await createEditTool().execute(
      {
        file_path: "preview.txt",
        old_string: "old",
        new_string: "new",
        dry_run: true,
      },
      createTestContext(tempRoot),
    );
    expect(result.output).toContain("Diff omitted");
    expect(result.metadata).toMatchObject({
      diff: "",
      diffOmitted: true,
      dryRun: true,
    });
    expect(await fs.readFile(target, "utf8")).toBe(original);
  });

  it("rejects an incomplete UTF-8 sequence at EOF", async () => {
    const target = path.join(tempRoot, "incomplete.txt");
    const original = Buffer.from([97, 0xe4, 0xb8]);
    await fs.writeFile(target, original);
    await expect(
      createEditTool().execute(
        { file_path: "incomplete.txt", old_string: "a", new_string: "z" },
        createTestContext(tempRoot),
      ),
    ).rejects.toThrow("UTF-8");
    expect(await fs.readFile(target)).toEqual(original);
  });
  it("reports a committed change when post-rename metadata cannot be read", async () => {
    const target = await writeFile(tempRoot, "metadata.txt", "old");

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
    const result = await createEditTool().execute(
      { file_path: "metadata.txt", old_string: "old", new_string: "new" },
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
  it("rejects a surrogate-splitting batch match without changing the 10 MiB original", async () => {
    const original = Buffer.from("😀".repeat(2_621_440));
    const target = path.join(tempRoot, "surrogate-budget.txt");
    await fs.writeFile(target, original);
    await expect(
      createEditTool().execute(
        {
          file_path: "surrogate-budget.txt",
          old_string: "\uD83D",
          new_string: "aa",
          replace_all: true,
        },
        createTestContext(tempRoot),
      ),
    ).rejects.toThrow("well-formed Unicode");
    expect((await fs.readFile(target)).equals(original)).toBe(true);
  });

  it.each(["\uD83D", "\uDE00"])(
    "rejects malformed replacement input %j before changing bytes",
    async (replacement) => {
      const target = await writeFile(
        tempRoot,
        "invalid-replacement.txt",
        "old",
      );
      await expect(
        createEditTool().execute(
          {
            file_path: "invalid-replacement.txt",
            old_string: "old",
            new_string: replacement,
          },
          createTestContext(tempRoot),
        ),
      ).rejects.toThrow("well-formed Unicode");
      expect(await fs.readFile(target, "utf8")).toBe("old");
    },
  );

  it("replaces whole emoji matches within the UTF-8 result budget", async () => {
    const target = await writeFile(tempRoot, "emoji.txt", "😀😀");
    const result = await createEditTool().execute(
      {
        file_path: "emoji.txt",
        old_string: "😀",
        new_string: "🌍",
        replace_all: true,
      },
      createTestContext(tempRoot),
    );
    expect(await fs.readFile(target, "utf8")).toBe("🌍🌍");
    expect(result.metadata).toMatchObject({
      sizeBytes: 8,
      replacementCount: 2,
    });
  });
});
