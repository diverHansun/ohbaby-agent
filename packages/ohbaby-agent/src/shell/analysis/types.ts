import type { ShellCommandClass } from "../command-classifier.js";
import type { ShellKind } from "../preflight.js";

export interface ShellCommandAnalysis {
  readonly source: string;
  readonly tokens: readonly string[];
  readonly root: string;
  readonly executedScript?: string;
  readonly inlineEval?: boolean;
  readonly interpreter?: string;
  readonly pathArgs: readonly string[];
  readonly arityKey: string;
  readonly danger: ShellCommandClass;
  readonly hasDynamic: boolean;
  /** Lexical cwd relative to the initial cwd; absent when control flow makes it unknown. */
  readonly cwd?: string;
  readonly cdTarget?: string;
  readonly pipelineId?: number;
  readonly downloadTargets?: readonly string[];
}

export interface ShellAnalysisResult {
  readonly shellKind: ShellKind;
  readonly commands: readonly ShellCommandAnalysis[];
  readonly completeness: "complete" | "incomplete";
  readonly incompleteReasons: readonly string[];
}
