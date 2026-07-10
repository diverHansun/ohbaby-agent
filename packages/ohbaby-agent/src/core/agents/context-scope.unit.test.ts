import { describe, expect, it } from "vitest";
import { createAgentContextScope } from "./context-scope.js";

const subIdentity = {
  agentName: "explore",
  contextScopeId: "subagent_1",
  instanceId: "subagent_1",
  modelId: "fake-model",
  parentSessionId: "parent_1",
  projectRoot: "/repo",
  sessionId: "child_1",
  type: "sub",
} as const;

const primaryIdentity = {
  agentName: "build",
  instanceId: "primary_1",
  modelId: "fake-model",
  projectRoot: "/repo",
  sessionId: "primary_1",
  type: "primary",
} as const;

describe("AgentContextScope", () => {
  it("derives stable run scope from subagent identity", () => {
    const scope = createAgentContextScope(subIdentity);

    expect(scope.isSubagent).toBe(true);
    expect(scope.toRunCreateOptions()).toEqual({
      agentInstanceId: "subagent_1",
      contextScopeId: "subagent_1",
      isSubagent: true,
      parentSessionId: "parent_1",
      sessionId: "child_1",
    });
  });

  it("keeps primary root instances unscoped at the message layer", () => {
    const scope = createAgentContextScope(primaryIdentity);

    expect(scope.isSubagent).toBe(false);
    expect(scope.contextScopeId).toBeUndefined();
    expect(scope.toRunCreateOptions()).toEqual({
      agentInstanceId: "primary_1",
      isSubagent: false,
      sessionId: "primary_1",
    });
  });

  it("rejects inconsistent identities and restored records", () => {
    expect(() =>
      createAgentContextScope({ ...subIdentity, parentSessionId: undefined }),
    ).toThrow(/parentSessionId/);
    expect(() =>
      createAgentContextScope({
        ...subIdentity,
        parentSessionId: "parent_1",
        type: "primary",
      }),
    ).toThrow(/primary/i);
    expect(() =>
      createAgentContextScope({
        ...primaryIdentity,
        contextScopeId: "primary_scope",
      }),
    ).toThrow(/contextScopeId/);

    const scope = createAgentContextScope(subIdentity);
    expect(() => {
      scope.assertSession({
        agentName: "research",
        contextScopeId: "subagent_1",
        instanceId: "subagent_1",
        parentSessionId: "parent_1",
        sessionId: "child_1",
      });
    }).toThrow(/agentName/);
    expect(() => {
      scope.assertSession({
        agentName: "explore",
        contextScopeId: "other_scope",
        instanceId: "subagent_1",
        parentSessionId: "parent_1",
        sessionId: "child_1",
      });
    }).toThrow(/contextScopeId/);
  });
});
