export { computeShellArityKey } from "./arity.js";
export { analyzeShellCommandLight } from "./light-parser.js";
export type { ShellAnalysisResult, ShellCommandAnalysis } from "./types.js";

// Stable seam: callers use analyzeShellCommand while the implementation can
// move from the lightweight parser to a tree-sitter parser later.
export { analyzeShellCommandLight as analyzeShellCommand } from "./light-parser.js";
