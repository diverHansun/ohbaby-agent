import { describe, expect, it } from "vitest";
import { shellLaunchCandidates } from "./shell-launch.js";

describe("shell launch configuration", () => {
  it("tries the preferred shell then POSIX fallbacks in login mode", () => {
    const launches = shellLaunchCandidates(
      "/work",
      { SHELL: "/custom/fish", SECRET: "inherited", LANG: "C", LC_ALL: "C" },
      "darwin",
    );
    expect(launches.map(({ file }) => file)).toEqual([
      "/custom/fish",
      "/bin/zsh",
      "/bin/bash",
      "/bin/sh",
    ]);
    expect(launches[0]).toMatchObject({
      args: ["-l"],
      cwd: "/work",
      env: {
        SECRET: "inherited",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LC_ALL: "en_US.UTF-8",
      },
    });
  });
  it("keeps an effective UTF-8 locale and never mutates the inherited environment", () => {
    const env = {
      SHELL: "/bin/zsh",
      LANG: "zh_TW.UTF-8",
      LC_CTYPE: "C",
      TERM: "dumb",
    };
    const launches = shellLaunchCandidates("/tmp", env, "linux");
    expect(launches.map(({ file }) => file)).toEqual([
      "/bin/zsh",
      "/bin/bash",
      "/bin/sh",
    ]);
    expect(launches[0]?.env.LC_CTYPE).toBe("C.UTF-8");
    expect(env.TERM).toBe("dumb");
  });
  it("uses Windows shell candidates without login arguments", () => {
    const launches = shellLaunchCandidates(
      "C:\\work",
      { LANG: "ja_JP.UTF-8" },
      "win32",
    );
    expect(launches.map(({ file, args }) => [file, args])).toEqual([
      ["pwsh.exe", []],
      ["powershell.exe", []],
      ["cmd.exe", []],
    ]);
    expect(launches[0]?.env.LANG).toBe("ja_JP.UTF-8");
  });
});
