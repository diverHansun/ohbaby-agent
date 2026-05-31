import { classifyPermissionCall } from "./classifier.js";
import { matchesPermissionRule } from "./matcher.js";
import type {
  Level,
  Mode,
  PermissionCall,
  PermissionDecision,
  PermissionRule,
  PermissionState,
} from "./types.js";

const PLAN_DENY_MESSAGE =
  "You are in plan mode. Write/Edit/Bash mutations and memory writes will be denied. Use read tools or ask the user to switch to auto mode.";

function allow(): PermissionDecision {
  return { type: "allow" };
}

function ask(reason?: string): PermissionDecision {
  return reason ? { reason, type: "ask" } : { type: "ask" };
}

function deny(reason: string): PermissionDecision {
  return { reason, type: "deny" };
}

function isAllowedInPlan(kind: string): boolean {
  return (
    kind === "readonly" ||
    kind === "network" ||
    kind === "memory-read" ||
    kind === "skill" ||
    kind === "bash-readonly"
  );
}

function evaluateModeGate(
  call: PermissionCall,
  mode: Mode,
): PermissionDecision | undefined {
  if (mode !== "plan") {
    return undefined;
  }
  const classification = classifyPermissionCall(call);
  if (isAllowedInPlan(classification.kind)) {
    return undefined;
  }
  return deny(`${PLAN_DENY_MESSAGE} Denied: ${classification.kind}.`);
}

function evaluateSessionRules(
  call: PermissionCall,
  rules: readonly PermissionRule[],
): PermissionDecision | undefined {
  for (const rule of rules) {
    if (rule.decision === "deny" && matchesPermissionRule(call, rule)) {
      return deny(rule.reason ?? "Denied by session permission rule.");
    }
  }
  for (const rule of rules) {
    if (rule.decision === "allow" && matchesPermissionRule(call, rule)) {
      return allow();
    }
  }
  return undefined;
}

function evaluateLevelFallback(
  call: PermissionCall,
  level: Level,
): PermissionDecision {
  const classification = classifyPermissionCall(call);
  if (call.toolName === "sensitive_path") {
    return ask(`Sensitive path access requires confirmation: ${call.toolName}`);
  }
  if (level === "full-access") {
    return allow();
  }

  switch (classification.kind) {
    case "readonly":
    case "network":
    case "memory-read":
    case "memory-write":
    case "subagent":
      return allow();
    case "skill":
      return ask(
        `Skill requires confirmation: ${classification.label ?? call.toolName}`,
      );
    case "bash-dangerous":
      return ask(
        `Dangerous shell command requires confirmation: ${call.toolName}`,
      );
    case "dangerous":
      return ask(`Dangerous tool requires confirmation: ${call.toolName}`);
    case "bash-readonly":
    case "bash-mutating":
      return ask(`Shell command requires confirmation: ${call.toolName}`);
    case "write":
      return ask(`Write tool requires confirmation: ${call.toolName}`);
    default:
      return deny("Unhandled permission category.");
  }
}

export function evaluatePermission(
  call: PermissionCall,
  state: PermissionState,
): PermissionDecision {
  const modeDecision = evaluateModeGate(call, state.mode);
  if (modeDecision) {
    return modeDecision;
  }

  const sessionRules = state.sessionRules.get(call.sessionId) ?? [];
  const ruleDecision = evaluateSessionRules(call, sessionRules);
  if (ruleDecision) {
    return ruleDecision;
  }

  return evaluateLevelFallback(call, state.level);
}
