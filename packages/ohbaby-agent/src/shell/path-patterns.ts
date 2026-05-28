export type ShellPathPatternKind = "static" | "glob" | "dynamic";

const TRUE_DYNAMIC_PATH_PATTERN =
  /`|\$\(|\$\{|<\(|>\(|%[A-Za-z_][A-Za-z0-9_]*%|\$env:|\$[A-Za-z_][A-Za-z0-9_]*/iu;
const GLOB_PATH_PATTERN = /[*?[\]{}]/u;

export interface GlobPathParts {
  readonly prefix: string;
  readonly suffix: string;
}

export function classifyShellPathPattern(target: string): ShellPathPatternKind {
  if (TRUE_DYNAMIC_PATH_PATTERN.test(target)) {
    return "dynamic";
  }
  if (GLOB_PATH_PATTERN.test(target)) {
    return "glob";
  }
  return "static";
}

export function splitGlobPath(target: string): GlobPathParts {
  const match = GLOB_PATH_PATTERN.exec(target);
  if (!match) {
    return { prefix: target, suffix: "" };
  }

  const firstGlobIndex = match.index;
  const beforeGlob = target.slice(0, firstGlobIndex);
  const slashIndex = Math.max(
    beforeGlob.lastIndexOf("/"),
    beforeGlob.lastIndexOf("\\"),
  );
  if (slashIndex < 0) {
    return { prefix: ".", suffix: target };
  }

  return {
    prefix: target.slice(0, slashIndex + 1),
    suffix: target.slice(slashIndex + 1),
  };
}
