export interface ShellLaunch {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Pure launch configuration; executable checks belong to the PTY adapter. */
export function shellLaunchCandidates(
  directory: string,
  inherited: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ShellLaunch[] {
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };
  const utf8 = platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  const effectiveLocale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(Boolean);
  if (!effectiveLocale || !/utf-?8/i.test(effectiveLocale)) {
    if (env.LC_ALL) env.LC_ALL = utf8;
    else env.LC_CTYPE = utf8;
    if (!env.LANG || !/utf-?8/i.test(env.LANG)) env.LANG = utf8;
  }
  const candidates =
    platform === "win32"
      ? ["pwsh.exe", "powershell.exe", "cmd.exe"]
      : [env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];
  return [
    ...new Set(candidates.filter((file): file is string => Boolean(file))),
  ].map((file) => ({
    file,
    args: platform === "win32" ? [] : ["-l"],
    cwd: directory,
    env,
  }));
}
