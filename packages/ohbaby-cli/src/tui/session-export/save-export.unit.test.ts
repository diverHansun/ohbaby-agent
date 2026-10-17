import { describe, expect, it, vi } from "vitest";
import { saveExportFile } from "./save-export.js";

describe("saveExportFile", () => {
  it("creates a missing directory and retains same-second exports without overwrite", async () => {
    const files = new Map<string, string>();
    const fs = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn(
        (
          file: string,
          content: string,
          options: { encoding: "utf8"; flag: "wx" },
        ) => {
          expect(options).toEqual({ encoding: "utf8", flag: "wx" });
          if (files.has(file))
            return Promise.reject(
              Object.assign(new Error("exists"), { code: "EEXIST" }),
            );
          files.set(file, content);
          return Promise.resolve();
        },
      ),
    };
    const directory = "/temporary/Downloads";
    await expect(
      saveExportFile(
        {
          directory,
          filename: "ohbaby-20261017-080000-first.html",
          content: "original",
        },
        fs,
      ),
    ).resolves.toBe(`${directory}/ohbaby-20261017-080000-first.html`);
    await expect(
      saveExportFile(
        {
          directory,
          filename: "ohbaby-20261017-080000-first.html",
          content: "second",
        },
        fs,
      ),
    ).resolves.toBe(`${directory}/ohbaby-20261017-080000-first-1.html`);
    await expect(
      saveExportFile(
        {
          directory,
          filename: "ohbaby-20261017-080000-other.html",
          content: "other",
        },
        fs,
      ),
    ).resolves.toBe(`${directory}/ohbaby-20261017-080000-other.html`);
    expect(files.get(`${directory}/ohbaby-20261017-080000-first.html`)).toBe(
      "original",
    );
    expect(files.size).toBe(3);
    expect(fs.mkdir).toHaveBeenCalledWith(directory, { recursive: true });
  });

  it.each(["../../safe.html", "..\\..\\safe.html"])(
    "only saves the basename for %s",
    async (filename) => {
      const fs = {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      };
      await expect(
        saveExportFile(
          { directory: "/temporary/Downloads", filename, content: "safe" },
          fs,
        ),
      ).resolves.toBe("/temporary/Downloads/safe.html");
    },
  );

  it("does not retry permission or disk failures", async () => {
    const error = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const fs = {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockRejectedValue(error),
    };
    await expect(
      saveExportFile(
        {
          directory: "/temporary/Downloads",
          filename: "fixture.html",
          content: "safe",
        },
        fs,
      ),
    ).rejects.toBe(error);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
  });
});
