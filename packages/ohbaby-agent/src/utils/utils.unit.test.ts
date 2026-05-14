import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IrisError,
  checkEmptyContent,
  contains,
  containsOrEqual,
  formatError,
  formatWithLineNumbers,
  getErrorMessage,
  lazy,
  lazyAsync,
  normalizePath,
  overlaps,
  truncateIfTooLong,
} from "./index.js";

describe("IrisError", () => {
  it("stores code, message, metadata and serializes them", () => {
    const cause = new Error("cause");
    const error = new IrisError(
      "TEST_ERROR",
      "Test failed",
      { key: "value" },
      { cause },
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("IrisError");
    expect(error.code).toBe("TEST_ERROR");
    expect(error.data).toEqual({ key: "value" });
    expect(error.cause).toBe(cause);
    expect(error.toObject()).toEqual({
      code: "TEST_ERROR",
      data: { key: "value" },
      message: "Test failed",
    });
    expect(IrisError.isInstance(error)).toBe(true);
  });

  it("formats unknown errors without losing useful messages", () => {
    expect(formatError(new IrisError("CODE", "A problem"))).toBe(
      "[CODE] A problem",
    );
    expect(formatError(new Error("Native problem"))).toBe("Native problem");
    expect(formatError("plain")).toBe("plain");
    expect(getErrorMessage({ message: "object message" })).toBe(
      "object message",
    );
  });
});

describe("path helpers", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-utils-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("normalizes paths and checks containment without treating equality as containment", () => {
    const root = path.resolve("workspace");
    const child = path.join(root, "src", "file.ts");

    expect(normalizePath(path.join(root, ".", "src", ".."))).toBe(root);
    expect(contains(root, child)).toBe(true);
    expect(contains(root, root)).toBe(false);
    expect(containsOrEqual(root, root)).toBe(true);
    expect(contains(root, path.resolve("workspace-other", "file.ts"))).toBe(
      false,
    );
    expect(contains(root, path.join(root, "..", "outside.ts"))).toBe(false);
  });

  it("detects overlapping path ranges", () => {
    const root = path.resolve("workspace");
    const child = path.join(root, "src");
    const other = path.resolve("other");

    expect(overlaps(root, child)).toBe(true);
    expect(overlaps(child, root)).toBe(true);
    expect(overlaps(root, root)).toBe(true);
    expect(overlaps(root, other)).toBe(false);
  });

  it("resolves existing symlink ancestors before checking missing descendants", async () => {
    const root = path.join(tempRoot, "root");
    const outside = path.join(tempRoot, "outside");
    const link = path.join(root, "linked-outside");
    const missingDescendant = path.join(link, "new-file.txt");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, link, "junction");

    expect(contains(root, missingDescendant)).toBe(false);
    expect(containsOrEqual(root, missingDescendant)).toBe(false);
  });
});

describe("lazy helpers", () => {
  it("initializes sync values once", () => {
    const init = vi.fn(() => ({ value: Math.random() }));
    const getter = lazy(init);

    const first = getter();
    const second = getter();

    expect(first).toBe(second);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("reuses the same promise for async initialization", async () => {
    const init = vi.fn(() => Promise.resolve("ready"));
    const getter = lazyAsync(init);

    const first = getter();
    const second = getter();

    expect(first).toBe(second);
    await expect(first).resolves.toBe("ready");
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("caches async initialization failures", async () => {
    const error = new Error("not ready");
    const init = vi.fn(() => Promise.reject(error));
    const getter = lazyAsync(init);

    const first = getter();
    const second = getter();

    expect(first).toBe(second);
    await expect(first).rejects.toBe(error);
    expect(init).toHaveBeenCalledTimes(1);
  });
});

describe("format helpers", () => {
  it("formats content with line numbers and split markers for long lines", () => {
    const result = formatWithLineNumbers(["ok", "abcdef"], {
      maxLineLength: 3,
      startLine: 10,
    });

    expect(result).toBe("10: ok\n11.1: abc\n11.2: def");
  });

  it("detects empty content", () => {
    expect(checkEmptyContent("  \n\t")).toBe("File is empty.");
    expect(checkEmptyContent("content")).toBeNull();
  });
});

describe("truncate helpers", () => {
  it("does not truncate short values", () => {
    expect(truncateIfTooLong("short", 10)).toBe("short");
    expect(truncateIfTooLong(["a", "b"], 10)).toEqual(["a", "b"]);
  });

  it("truncates long strings and arrays with a guidance marker", () => {
    const stringResult = truncateIfTooLong("abcdefghij", 2);
    const arrayResult = truncateIfTooLong(["alpha", "beta", "gamma"], 3);

    expect(stringResult).toBe("abcdefgh\n\n... [results truncated]");
    expect(arrayResult).toEqual(["alpha", "beta", "... [results truncated]"]);
  });
});
