import { describe, expect, it, vi } from "vitest";
import {
  createDirectoryBrowser,
  DirectoryBrowserError,
  type DirectoryBrowserErrorCode,
} from "./directory-browser.js";

function directory(): { readonly isDirectory: () => boolean } {
  return { isDirectory: (): boolean => true };
}

function file(): { readonly isDirectory: () => boolean } {
  return { isDirectory: (): boolean => false };
}

function fileSystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("DirectoryBrowser", () => {
  it("lists only accessible Windows drive roots in name order", async () => {
    const stat = vi.fn((directoryPath: string) => {
      if (directoryPath === "C:\\" || directoryPath === "D:\\") {
        return Promise.resolve(directory());
      }
      return Promise.reject(fileSystemError("ENOENT"));
    });
    const browser = createDirectoryBrowser({
      platform: "win32",
      stat,
    });

    await expect(browser.listRoots()).resolves.toEqual([
      { directory: "C:\\", name: "C:\\" },
      { directory: "D:\\", name: "D:\\" },
    ]);
  });

  it.each(["linux", "darwin"] as const)(
    "uses the filesystem root on %s",
    async (platform) => {
      const stat = vi.fn();
      const browser = createDirectoryBrowser({
        platform,
        stat,
      });

      await expect(browser.listRoots()).resolves.toEqual([
        { directory: "/", name: "/" },
      ]);
      expect(stat).not.toHaveBeenCalled();
    },
  );

  it("returns sorted direct child directories and the server-calculated parent", async () => {
    const browser = createDirectoryBrowser({
      platform: "linux",
      readdir: vi.fn(() =>
        Promise.resolve([
          { isDirectory: (): boolean => true, name: "zebra" },
          { isDirectory: (): boolean => false, name: "readme.md" },
          { isDirectory: (): boolean => true, name: "alpha" },
        ]),
      ),
      stat: vi.fn(() => Promise.resolve(directory())),
    });

    await expect(browser.list("/projects/demo")).resolves.toEqual({
      children: [
        { directory: "/projects/demo/alpha", name: "alpha" },
        { directory: "/projects/demo/zebra", name: "zebra" },
      ],
      directory: "/projects/demo",
      parent: "/projects",
    });
  });

  it("does not expose a parent above the filesystem root", async () => {
    const browser = createDirectoryBrowser({
      platform: "linux",
      readdir: vi.fn(() => Promise.resolve([])),
      stat: vi.fn(() => Promise.resolve(directory())),
    });

    await expect(browser.list("/")).resolves.toEqual({
      children: [],
      directory: "/",
      parent: null,
    });
  });

  const errorCases = [
    ["relative/project", "INVALID_DIRECTORY", fileSystemError("ENOENT")],
    ["/missing", "DIRECTORY_NOT_FOUND", fileSystemError("ENOENT")],
    ["/file", "DIRECTORY_NOT_A_DIRECTORY", undefined],
    ["/restricted", "DIRECTORY_NOT_READABLE", fileSystemError("EACCES")],
  ] as const satisfies readonly (readonly [
    string,
    DirectoryBrowserErrorCode,
    NodeJS.ErrnoException | undefined,
  ])[];

  it.each(errorCases)(
    "maps %s to the structured %s error",
    async (directoryPath, code, statError) => {
      const browser = createDirectoryBrowser({
        platform: "linux",
        readdir: vi.fn(() => {
          if (statError) {
            return Promise.reject(statError);
          }
          return Promise.resolve([]);
        }),
        stat: vi.fn(() => {
          if (statError) {
            return Promise.reject(statError);
          }
          return Promise.resolve(file());
        }),
      });

      await expect(browser.list(directoryPath)).rejects.toMatchObject({
        code,
      } satisfies Partial<DirectoryBrowserError>);
    },
  );
});
