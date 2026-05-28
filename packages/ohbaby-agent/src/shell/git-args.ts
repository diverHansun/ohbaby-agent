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
const GIT_GLOBAL_PATH_OPTIONS_WITH_VALUE = new Set([
  "--git-dir",
  "--work-tree",
  "-C",
]);
const GIT_GLOBAL_INLINE_PATH_OPTIONS = new Set(["--exec-path"]);

function optionHasInlineValue(option: string): boolean {
  return option.includes("=");
}

function optionName(option: string): string {
  return option.split("=", 1)[0];
}

function inlineOptionValue(option: string): string | undefined {
  const equalsIndex = option.indexOf("=");
  return equalsIndex > 0 ? option.slice(equalsIndex + 1) : undefined;
}

export function normalizeGitArgs(args: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const name = optionName(arg);
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(name)) {
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

export function gitGlobalPathArgs(args: readonly string[]): readonly string[] {
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const name = optionName(arg);
    const inlineValue = inlineOptionValue(arg);
    if (GIT_GLOBAL_PATH_OPTIONS_WITH_VALUE.has(name)) {
      if (inlineValue !== undefined) {
        paths.push(inlineValue);
        continue;
      }
      if (args[index + 1]) {
        paths.push(args[index + 1]);
        index += 1;
      }
      continue;
    }
    if (GIT_GLOBAL_INLINE_PATH_OPTIONS.has(name) && inlineValue !== undefined) {
      paths.push(inlineValue);
    }
  }

  return paths;
}

export function gitSubcommand(args: readonly string[]): string | undefined {
  return normalizeGitArgs(args)
    .find((arg) => !arg.startsWith("-"))
    ?.toLowerCase();
}
