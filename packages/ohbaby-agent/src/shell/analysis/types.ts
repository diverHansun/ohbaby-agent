import type { ShellCommandClass } from "../command-classifier.js";
import type { ShellKind } from "../preflight.js";

export interface ShellCommandAnalysis {
  readonly source: string;
  readonly tokens: readonly string[];
  readonly root: string;
  readonly pathArgs: readonly string[];
  readonly arityKey: string;
  readonly danger: ShellCommandClass;
  readonly hasDynamic: boolean;
}

export interface ShellAnalysisResult {
  readonly shellKind: ShellKind;
  readonly commands: readonly ShellCommandAnalysis[];
  readonly parseError?: string;
}
