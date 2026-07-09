import type { AgentContextScope, AgentInstanceIdentity } from "./types.js";

function assertNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
}

function assertEqual(
  actual: string | undefined,
  expected: string | undefined,
  name: string,
): void {
  if (actual !== undefined && actual !== expected) {
    throw new Error(
      `${name} mismatch: expected ${expected ?? "<none>"}, got ${actual}`,
    );
  }
}

function validateIdentity(identity: AgentInstanceIdentity): void {
  assertNonEmpty(identity.instanceId, "instanceId");
  assertNonEmpty(identity.contextScopeId, "contextScopeId");
  assertNonEmpty(identity.sessionId, "sessionId");
  assertNonEmpty(identity.agentName, "agentName");
  assertNonEmpty(identity.projectRoot, "projectRoot");
  assertNonEmpty(identity.modelId, "modelId");

  if (identity.type === "sub" && !identity.parentSessionId) {
    throw new Error("sub agent identity requires parentSessionId");
  }
  if (identity.type === "primary" && identity.parentSessionId !== undefined) {
    throw new Error("primary agent identity must not include parentSessionId");
  }
}

export function createAgentContextScope(
  identity: AgentInstanceIdentity,
): AgentContextScope {
  validateIdentity(identity);
  const isSubagent = identity.type === "sub";

  return {
    identity,
    instanceId: identity.instanceId,
    contextScopeId: identity.contextScopeId,
    sessionId: identity.sessionId,
    isSubagent,
    ...(identity.parentSessionId === undefined
      ? {}
      : { parentSessionId: identity.parentSessionId }),

    assertSession(input): void {
      assertEqual(input.sessionId, identity.sessionId, "sessionId");
      assertEqual(input.instanceId, identity.instanceId, "instanceId");
      assertEqual(
        input.contextScopeId,
        identity.contextScopeId,
        "contextScopeId",
      );
      assertEqual(
        input.parentSessionId,
        identity.parentSessionId,
        "parentSessionId",
      );
      assertEqual(input.agentName, identity.agentName, "agentName");
    },

    toRunCreateOptions(): ReturnType<AgentContextScope["toRunCreateOptions"]> {
      return {
        agentInstanceId: identity.instanceId,
        contextScopeId: identity.contextScopeId,
        isSubagent,
        ...(identity.parentSessionId === undefined
          ? {}
          : { parentSessionId: identity.parentSessionId }),
        sessionId: identity.sessionId,
      };
    },
  };
}
