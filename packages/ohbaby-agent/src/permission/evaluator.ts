import {
  classifyPermissionCall,
  type PermissionClassification,
} from "./classifier.js";
import { matchesPermissionRule } from "./matcher.js";
import type {
  Level,
  PermissionCall,
  PermissionDecision,
  PermissionRule,
  PermissionState,
} from "./types.js";

function allow(): PermissionDecision {
  return { type: "allow" };
}

function ask(
  reason?: string,
  input: { readonly rememberable?: boolean } = {},
): PermissionDecision {
  const decision: Extract<PermissionDecision, { readonly type: "ask" }> =
    reason ? { reason, type: "ask" } : { type: "ask" };
  return input.rememberable === undefined
    ? decision
    : { ...decision, rememberable: input.rememberable };
}

function deny(reason: string): PermissionDecision {
  return { reason, type: "deny" };
}

function evaluateSessionDenyRules(
  call: PermissionCall,
  rules: readonly PermissionRule[],
): PermissionDecision | undefined {
  for (const rule of rules) {
    if (rule.decision === "deny" && matchesPermissionRule(call, rule)) {
      return deny(rule.reason ?? "Denied by session permission rule.");
    }
  }
  return undefined;
}

function evaluateSessionAllowRules(
  call: PermissionCall,
  rules: readonly PermissionRule[],
): PermissionDecision | undefined {
  for (const rule of rules) {
    if (rule.decision === "allow" && matchesPermissionRule(call, rule)) {
      return allow();
    }
  }
  return undefined;
}

function evaluateInvariantDecision(
  call: PermissionCall,
  classification: PermissionClassification,
): PermissionDecision | undefined {
  if (classification.kind === "sensitive") {
    return ask(
      `Sensitive path access requires confirmation: ${call.toolName}`,
      { rememberable: false },
    );
  }
  return undefined;
}

function evaluateLevelFallback(
  call: PermissionCall,
  classification: PermissionClassification,
  level: Level,
): PermissionDecision {
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
    case "sensitive":
      return ask(
        `Sensitive path access requires confirmation: ${call.toolName}`,
        { rememberable: false },
      );
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
  const classification = classifyPermissionCall(call);
  const sessionRules = state.sessionRules.get(call.sessionId) ?? [];
  const denyDecision = evaluateSessionDenyRules(call, sessionRules);
  if (denyDecision) {
    return denyDecision;
  }

  const invariantDecision = evaluateInvariantDecision(call, classification);
  if (invariantDecision) {
    return invariantDecision;
  }

  const allowDecision = evaluateSessionAllowRules(call, sessionRules);
  if (allowDecision) {
    return allowDecision;
  }

  return evaluateLevelFallback(call, classification, state.level);
}
