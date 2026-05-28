const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
  "-C",
  "-c",
]);

function optionHasInlineValue(option: string): boolean {
  return option.includes("=");
}

export function normalizeGitArgs(args: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const optionName = arg.split("=", 1)[0];
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(optionName)) {
      if (!optionHasInlineValue(arg)) {
        index += 1;
      }
      continue;
    }
    if (arg === "--no-pager" || arg === "--bare") {
      continue;
    }
    normalized.push(arg);
  }

  return normalized;
}

export function gitSubcommand(args: readonly string[]): string | undefined {
  return normalizeGitArgs(args)
    .find((arg) => !arg.startsWith("-"))
    ?.toLowerCase();
}
