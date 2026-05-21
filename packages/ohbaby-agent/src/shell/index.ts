import { lazy } from "../utils/index.js";
import { resolveAcceptableShell, resolvePreferredShell } from "./detector.js";
import { killTree } from "./process.js";

const preferred = lazy(() => resolvePreferredShell());
const acceptable = lazy(() => resolveAcceptableShell());

export { BLACKLISTED_SHELLS, SIGKILL_TIMEOUT_MS } from "./constants.js";
export {
  detectShellKind,
  preflightShellCommand,
  shellArgs,
  ShellCommandPolicyError,
  type ShellKind,
  type ShellPreflightInput,
  type ShellPreflightResult,
} from "./command-policy.js";
export {
  deriveGitBashPath,
  isBlacklistedShell,
  resolveAcceptableShell,
  resolvePreferredShell,
  type ShellDetectionInput,
} from "./detector.js";
export {
  killTree,
  killTreeWithPlatform,
  type KillTreeOptions,
  type KillTreePlatformOptions,
} from "./process.js";

export const Shell = {
  acceptable,
  killTree,
  preferred,
} as const;
