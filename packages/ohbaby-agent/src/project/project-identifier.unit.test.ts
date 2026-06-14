import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe("getGitProjectId", () => {
  it("hides the git project-id lookup process window", async () => {
    const optionsSeen: unknown[] = [];
    const execFile = vi.fn();
    Object.assign(execFile, {
      [promisify.custom]: (
        _file: string,
        _args: readonly string[],
        options: unknown,
      ) => {
        optionsSeen.push(options);
        return Promise.resolve({
          stderr: "",
          stdout:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n" +
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        });
      },
    });
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("node:child_process")>();
      return { ...actual, execFile };
    });
    const { getGitProjectId } = await import("./project-identifier.js");

    await expect(getGitProjectId("C:\\repo")).resolves.toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    expect(optionsSeen).toEqual([
      expect.objectContaining({ windowsHide: true }),
    ]);
  });
});
