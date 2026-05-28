import type { CommandDetail } from "../../utils/index.js";
import { parseCommand } from "../../utils/index.js";
import { classifyShellCommandDetail } from "../command-classifier.js";
import { extractShellPathFacts } from "../path-args.js";
import type { ShellKind } from "../preflight.js";
import { computeShellArityKey } from "./arity.js";
import type { ShellAnalysisResult, ShellCommandAnalysis } from "./types.js";

const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;
const DYNAMIC_PATTERN =
  /`|\$\(|\$\{|<\(|>\(|%[A-Za-z_][A-Za-z0-9_]*%|\$env:|\$[A-Za-z_][A-Za-z0-9_]*/iu;

function normalizeRoot(root: string): string {
  return root.toLowerCase().replace(/\.exe$/u, "");
}

function analyzeDetail(detail: CommandDetail): ShellCommandAnalysis {
  const tokens = detail.tokens.slice(detail.rootIndex);
  const root = normalizeRoot(detail.root);
  const facts = extractShellPathFacts({
    ...detail,
    root,
  });
  const analysis: ShellCommandAnalysis = {
    arityKey: computeShellArityKey(tokens),
    danger: classifyShellCommandDetail(detail),
    hasDynamic: DYNAMIC_PATTERN.test(detail.text),
    pathArgs: facts.pathArgs.filter(
      (candidate) => !URL_PATTERN.test(candidate),
    ),
    root,
    source: detail.text,
    tokens,
  };
  if (facts.executedScript) {
    return {
      ...analysis,
      executedScript: facts.executedScript,
      interpreter: facts.interpreter,
    };
  }
  if (facts.inlineEval) {
    return {
      ...analysis,
      inlineEval: facts.inlineEval,
      interpreter: facts.interpreter,
    };
  }
  if (facts.interpreter) {
    return {
      ...analysis,
      interpreter: facts.interpreter,
    };
  }

  return analysis;
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
