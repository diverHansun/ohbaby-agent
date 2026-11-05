import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listSessionFiles,
  readSessionFile,
  writeToolOutput,
} from "./session-storage.js";

let home: string;
let scratch: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "session-files-"));
  vi.stubEnv("OHBABY_HOME", home);
  scratch = path.join(home, "sessions", "root", "scratch");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});
async function put(name: string, content: string | Buffer): Promise<void> {
  const target = path.join(scratch, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

describe("session scratch files", () => {
  it("lists only sorted nested regular scratch files with metadata", async () => {
    await put("z.txt", "last");
    await put("nested/a.txt", "first");
    await fs.mkdir(path.join(home, "sessions", "other", "scratch"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(home, "sessions", "other", "scratch", "secret"),
      "private",
    );
    await fs.mkdir(path.join(home, "sessions", "root", "tool-results"));
    await fs.writeFile(
      path.join(home, "sessions", "root", "tool-results", "hidden"),
      "system",
    );
    await fs.symlink(
      path.join(home, "sessions", "other", "scratch"),
      path.join(scratch, "linked-dir"),
      "junction",
    );
    await fs.symlink(
      path.join(scratch, "z.txt"),
      path.join(scratch, "linked-file"),
    );
    const files = await listSessionFiles("root");
    expect(files.map(({ path, size }) => ({ path, size }))).toEqual([
      { path: "nested/a.txt", size: 5 },
      { path: "z.txt", size: 4 },
    ]);
    expect(Number.isFinite(Date.parse(files[0].modifiedAt))).toBe(true);
  });

  it("returns an empty list without creating missing storage", async () => {
    expect(await listSessionFiles("root")).toEqual([]);
    await expect(fs.stat(path.join(home, "sessions"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readSessionFile("root", "missing.txt")).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
  });

  it("keeps a non-directory tool-results file unchanged and reports unavailable output", async () => {
    await put("file", "safe");
    const root = await fs.realpath(path.dirname(scratch));
    const target = path.join(root, "tool-results");
    await fs.writeFile(target, "preserve me", { mode: 0o600 });
    const before = await fs.stat(target);
    const result = await writeToolOutput({
      environment: {
        trustedRoots: () => [{ kind: "session-storage", path: root }],
      },
      callId: "call",
      text: "new output",
    });
    expect(result.status).toBe("unavailable");
    expect(await fs.readFile(target, "utf8")).toBe("preserve me");
    expect((await fs.stat(target)).mode).toBe(before.mode);
  });

  it.each([
    "hello 中文 👋",
    "",
    "<html><script>alert(1)</script></html>",
    "<svg></svg>",
  ])("reads valid UTF-8 text %j", async (text) => {
    await put("text.svg", text);
    expect(await readSessionFile("root", "text.svg")).toEqual({
      kind: "text",
      text,
    });
  });

  it.each([
    ["png", "89504e470d0a1a0a", "image/png"],
    ["jpeg", "ffd8ffe0", "image/jpeg"],
    ["gif87", "474946383761", "image/gif"],
    ["gif89", "474946383961", "image/gif"],
    ["webp", "524946460400000057454250", "image/webp"],
  ])(
    "detects %s from bytes regardless of extension",
    async (_name, hex, contentType) => {
      const bytes = Buffer.from(hex, "hex");
      await put("image.data", bytes);
      expect(await readSessionFile("root", "image.data")).toEqual({
        kind: "image",
        contentType,
        bytes,
      });
    },
  );

  it.each([
    Buffer.from([0, 1, 2]),
    Buffer.from([0xc3, 0x28]),
    Buffer.from("BM\0bad"),
  ])("rejects unsupported or malformed UTF-8 bytes %j", async (bytes) => {
    await put("invalid.txt", bytes);
    await expect(readSessionFile("root", "invalid.txt")).rejects.toMatchObject({
      code: "UNSUPPORTED_FILE_TYPE",
    });
  });

  it("does not trust an image extension", async () => {
    await put("fake.png", "not an image");
    await expect(readSessionFile("root", "fake.png")).rejects.toMatchObject({
      code: "UNSUPPORTED_FILE_TYPE",
    });
  });

  it("requires exact image signatures without masking high bits", async () => {
    await put("fake", Buffer.from([0xc7, 0xc9, 0xc6, 0xb8, 0xb9, 0xe1]));
    await expect(readSessionFile("root", "fake")).rejects.toMatchObject({
      code: "UNSUPPORTED_FILE_TYPE",
    });
  });

  it("recognizes image signatures even when the first handle read is short", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await put("image", png);
    const original = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await original(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementationOnce(
        async (...readArgs: Parameters<typeof handle.read>) => {
          if (!Buffer.isBuffer(readArgs[0]))
            throw new Error("Expected buffer read");
          return read({
            buffer: readArgs[0],
            offset: 0,
            length: 3,
            position: 0,
          });
        },
      );
      return handle;
    });
    expect(await readSessionFile("root", "image")).toEqual({
      kind: "image",
      contentType: "image/png",
      bytes: png,
    });
  });

  it.each([
    ["text", 1024 * 1024],
    ["image", 10 * 1024 * 1024],
  ])(
    "accepts exactly the %s limit and rejects one more byte",
    async (kind, limit) => {
      const content = Buffer.alloc(limit, 0x61);
      if (kind === "image")
        Buffer.from("89504e470d0a1a0a", "hex").copy(content);
      await put("limit", content);
      expect((await readSessionFile("root", "limit")).kind).toBe(kind);
      await fs.appendFile(path.join(scratch, "limit"), "a");
      await expect(readSessionFile("root", "limit")).rejects.toMatchObject({
        code: "FILE_TOO_LARGE",
      });
    },
  );

  it.each([
    "",
    "../secret",
    "nested/../../secret",
    "/etc/passwd",
    "a\0b",
    "C:\\secret",
    "..\\secret",
  ])("rejects unsafe relative path %j", async (name) => {
    await put("normal", "safe");
    await expect(readSessionFile("root", name)).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  });

  it("rejects invalid owner identifiers", async () => {
    await expect(listSessionFiles("../root")).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    await expect(readSessionFile("../root", "file")).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  });

  it("reads a legitimate double-dot filename prefix without allowing traversal", async () => {
    await put("..notes", "legitimate");
    expect(await readSessionFile("root", "..notes")).toEqual({
      kind: "text",
      text: "legitimate",
    });
  });

  it("rejects missing files, directories, FIFOs and parent/final symlinks", async () => {
    await put("nested/file", "safe");
    await fs.symlink(
      path.join(scratch, "nested"),
      path.join(scratch, "parent-link"),
      "junction",
    );
    await fs.symlink(
      path.join(scratch, "nested", "file"),
      path.join(scratch, "file-link"),
    );
    for (const name of ["nested", "parent-link/file", "file-link"])
      await expect(readSessionFile("root", name)).rejects.toMatchObject({
        code: "INVALID_PATH",
      });
    await expect(readSessionFile("root", "missing")).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [path.join(scratch, "pipe")]);
      await expect(readSessionFile("root", "pipe")).rejects.toMatchObject({
        code: "INVALID_PATH",
      });
    }
  });

  it.each(["sessions", "owner", "scratch"])(
    "rejects redirected %s subtrees",
    async (level) => {
      await put("file", "safe");
      const target =
        level === "sessions"
          ? path.join(home, "sessions")
          : level === "owner"
            ? path.dirname(scratch)
            : scratch;
      const moved = path.join(home, "redirected");
      await fs.rename(target, moved);
      await fs.symlink(moved, target, "junction");
      await expect(listSessionFiles("root")).rejects.toMatchObject({
        code: "INVALID_PATH",
      });
      await expect(readSessionFile("root", "file")).rejects.toMatchObject({
        code: "INVALID_PATH",
      });
    },
  );

  it("allows a canonical home alias without allowing redirected session components", async () => {
    await put("file", "safe");
    const alias = `${home}-alias`;
    await fs.symlink(home, alias, "junction");
    vi.stubEnv("OHBABY_HOME", alias);
    try {
      expect(await readSessionFile("root", "file")).toEqual({
        kind: "text",
        text: "safe",
      });
    } finally {
      await fs.rm(alias, { force: true });
    }
  });

  it("does not hide unexpected listing failures as empty success", async () => {
    await put("file", "safe");
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    await expect(listSessionFiles("root")).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("rejects a parent swapped between validation and open even if restored before delivery", async () => {
    await put("nested/file", "safe");
    const outside = path.join(home, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "file"), "secret");
    const original = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const nested = path.join(scratch, "nested");
      await fs.rename(nested, `${nested}-saved`);
      await fs.symlink(outside, nested, "junction");
      const handle = await original(...args);
      await fs.unlink(nested);
      await fs.rename(`${nested}-saved`, nested);
      return handle;
    });
    await expect(readSessionFile("root", "nested/file")).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  });

  it("rejects file replacement during a read and closes the handle", async () => {
    await put("file", "safe");
    const original = fs.open.bind(fs);
    let closed = false;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await original(...args);
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "read").mockImplementationOnce(
        async (...readArgs: Parameters<typeof handle.read>) => {
          await fs.rename(
            path.join(scratch, "file"),
            path.join(scratch, "saved"),
          );
          await fs.writeFile(path.join(scratch, "file"), "replacement");
          return read(...readArgs);
        },
      );
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closed = true;
        await close();
      });
      return handle;
    });
    await expect(readSessionFile("root", "file")).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(closed).toBe(true);
  });

  it("closes the file handle and preserves an unexpected read error", async () => {
    await put("file", "safe");
    const original = fs.open.bind(fs);
    let closed = false;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await original(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "read").mockRejectedValueOnce(
        Object.assign(new Error("disk read failed"), { code: "EIO" }),
      );
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closed = true;
        await close();
      });
      return handle;
    });
    await expect(readSessionFile("root", "file")).rejects.toMatchObject({
      code: "EIO",
    });
    expect(closed).toBe(true);
  });

  it("bounds an actual read when the file grows after fstat", async () => {
    await put("growing", "small");
    const original = fs.open.bind(fs);
    let largestRead = 0;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await original(...args);
      const read = handle.read.bind(handle);
      let grown = false;
      vi.spyOn(handle, "read").mockImplementation(
        async (...readArgs: Parameters<typeof handle.read>) => {
          if (!grown) {
            grown = true;
            await fs.writeFile(
              path.join(scratch, "growing"),
              Buffer.alloc(2 * 1024 * 1024, 0x61),
            );
          }
          const result = await read(...readArgs);
          if (Buffer.isBuffer(readArgs[0]))
            largestRead = Math.max(largestRead, readArgs[0].length);
          return result;
        },
      );
      return handle;
    });
    await expect(readSessionFile("root", "growing")).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
    expect(largestRead).toBeGreaterThan(0);
    expect(largestRead).toBeLessThanOrEqual(1024 * 1024 + 1);
  });
});
