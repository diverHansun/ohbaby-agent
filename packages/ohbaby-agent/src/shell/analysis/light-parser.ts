import type { CommandDetail } from "../../utils/index.js";
import { parseCommand } from "../../utils/index.js";
import { classifyShellCommand } from "../command-classifier.js";
import { extractShellPathArgs } from "../path-args.js";
import type { ShellKind } from "../preflight.js";
import { computeShellArityKey } from "./arity.js";
import type { ShellAnalysisResult, ShellCommandAnalysis } from "./types.js";

const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;
const DYNAMIC_PATTERN =
  /`|\$\(|\$\{|<\(|>\(|%[A-Za-z_][A-Za-z0-9_]*%|\$env:|\$[A-Za-z_][A-Za-z0-9_]*/iu;

function normalizeRoot(root: string): string {
  return root.toLowerCase().replace(/\.exe$/u, "");
}

function pathArgs(detail: CommandDetail, root: string): readonly string[] {
  return extractShellPathArgs({
    ...detail,
    root,
  }).filter((candidate) => !URL_PATTERN.test(candidate));
}

function commandDanger(source: string): ShellCommandAnalysis["danger"] {
  return classifyShellCommand(parseCommand(source));
}

function analyzeDetail(detail: CommandDetail): ShellCommandAnalysis {
  const tokens = detail.tokens.slice(detail.rootIndex);
  const root = normalizeRoot(detail.root);
  return {
    arityKey: computeShellArityKey(tokens),
    danger: commandDanger(detail.text),
    hasDynamic: DYNAMIC_PATTERN.test(detail.text),
    pathArgs: pathArgs(detail, root),
    root,
    source: detail.text,
    tokens,
  };
}

export function analyzeShellCommandLight(
  command: string,
  shellKind: ShellKind,
): Promise<ShellAnalysisResult> {
  const parsed = parseCommand(command);
  return Promise.resolve({
    commands: parsed.details.map(analyzeDetail),
    parseError: parsed.hasError
      ? "Shell command contains unsupported or incomplete syntax; analysis used lightweight fallback facts."
      : undefined,
    shellKind,
  });
}
