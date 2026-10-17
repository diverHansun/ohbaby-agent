import { describe, expect, it, vi } from "vitest";
import { resolveDownloadsDir } from "./downloads-dir.js";

describe("resolveDownloadsDir", () => {
  it.each([
    {
      platform: "darwin",
      homedir: "/Users/fixture",
      expected: "/Users/fixture/Downloads",
    },
    {
      platform: "win32",
      homedir: "C:\\Users\\fixture",
      expected: "C:\\Users\\fixture\\Downloads",
    },
    {
      platform: "linux",
      homedir: "/home/fixture",
      expected: "/home/fixture/Downloads",
    },
  ] as const)(
    "uses the platform convention on $platform",
    ({ platform, homedir, expected }) => {
      expect(
        resolveDownloadsDir({
          platform,
          homedir,
          env: {},
          readFile: () => undefined,
        }),
      ).toBe(expected);
    },
  );

  it.each(["/tmp/下载", "$HOME/下载", "${HOME}/下载"])(
    "uses valid Linux environment value %s first",
    (value) => {
      const readFile = vi.fn();
      expect(
        resolveDownloadsDir({
          platform: "linux",
          homedir: "/home/fixture",
          env: { XDG_DOWNLOAD_DIR: value },
          readFile,
        }),
      ).toBe(value.startsWith("/") ? value : "/home/fixture/下载");
      expect(readFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    "",
    "relative",
    "$OTHER/下载",
    "`cmd`",
    "$(cmd)",
    "/tmp/$(cmd)",
    "/tmp/`cmd`",
    "~/下载",
  ])("rejects unsafe or nonabsolute value %s in env and config", (value) => {
    expect(
      resolveDownloadsDir({
        platform: "linux",
        homedir: "/home/fixture",
        env: { XDG_DOWNLOAD_DIR: value },
        readFile: () => `XDG_DOWNLOAD_DIR="${value}"`,
      }),
    ).toBe("/home/fixture/Downloads");
  });

  it("falls through an invalid environment to a valid Chinese config path", () => {
    const readFile = vi.fn(() => 'XDG_DOWNLOAD_DIR="$HOME/下载"\n');
    expect(
      resolveDownloadsDir({
        platform: "linux",
        homedir: "/home/fixture",
        env: {
          XDG_DOWNLOAD_DIR: "relative",
          XDG_CONFIG_HOME: "relative-config",
        },
        readFile,
      }),
    ).toBe("/home/fixture/下载");
    expect(readFile).toHaveBeenCalledWith(
      "/home/fixture/.config/user-dirs.dirs",
    );
  });

  it("uses an absolute config directory", () => {
    const readFile = vi.fn(() => 'XDG_DOWNLOAD_DIR="/mnt/downloads"');
    expect(
      resolveDownloadsDir({
        platform: "linux",
        homedir: "/home/fixture",
        env: { XDG_CONFIG_HOME: "/mnt/config" },
        readFile,
      }),
    ).toBe("/mnt/downloads");
    expect(readFile).toHaveBeenCalledWith("/mnt/config/user-dirs.dirs");
  });

  it.each([
    undefined,
    "garbage",
    'XDG_DOWNLOAD_DIR="unterminated',
    "XDG_DOWNLOAD_DIR=relative",
  ])(
    "silently falls back for unreadable or malformed config %s",
    (contents) => {
      expect(
        resolveDownloadsDir({
          platform: "linux",
          homedir: "/home/fixture",
          env: {},
          readFile: () => contents,
        }),
      ).toBe("/home/fixture/Downloads");
    },
  );
});
