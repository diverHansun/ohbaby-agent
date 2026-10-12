import type { ShellAnalysisResult } from "./analysis/types.js";
import type { ShellPreflightResult } from "./preflight.js";
import type { PreflightResult } from "../sandbox/types.js";
/** Internal execution parameters fixed before permissions; never accepted from model input. */
export interface ShellExecutionBinding {
  readonly command: string;
  readonly shell: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly commandPrefix: readonly string[];
  /** Existing job metadata projected during preparation; never a second analysis input. */
  readonly metadata?: {
    readonly cdTargets: readonly string[];
    readonly resolvedPaths: readonly string[];
    readonly paths: readonly string[];
    readonly roots: readonly string[];
  };
}
export interface BashPreparation {
  readonly shellAnalysis: ShellAnalysisResult;
  readonly shellExecution: ShellExecutionBinding;
  readonly shellPreflight: ShellPreflightResult;
  readonly sandboxPreflight: PreflightResult;
}
