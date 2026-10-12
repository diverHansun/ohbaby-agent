import { describe, expect, it } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import { analyzeShellCommand } from "../../../packages/ohbaby-agent/src/shell/analysis/index.js";
import {
  createPermissionState,
  createPermissionManager,
  evaluatePermission,
  generatePermissionPattern,
  InvalidPermissionChoiceError,
} from "../../../packages/ohbaby-agent/src/permission/index.js";

const identity = {
  runId: "run",
  sessionId: "child",
  messageId: "message",
  callId: "call",
  toolName: "bash",
  category: "dangerous" as const,
  source: { rootSessionId: "root", ancestorSessionIds: ["root"] },
  signal: new AbortController().signal,
};
describe("trusted shell analysis in permission decisions", () => {
  it("asks default incomplete calls despite old broad allow and keeps Always unavailable", async () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    state.addSessionRule("child", {
      tool: "bash",
      pattern: "*",
      decision: "allow",
      scope: "session",
    });
    const call = {
      ...identity,
      params: { command: "echo $(printf value)" },
      shellAnalysis: await analyzeShellCommand("echo $(printf value)", "bash"),
    };
    expect(evaluatePermission(call, state.getState())).toMatchObject({
      type: "ask",
      rememberable: false,
    });
    const manager = createPermissionManager({ bus, state });
    try {
      const response = manager.ask(call);
      const pending = manager.listPending()[0];
      expect(pending).toMatchObject({
        rootSessionId: "root",
        sessionId: "child",
        metadata: { rememberable: false },
      });
      expect(() =>
        manager.respond("child", pending.id, { type: "always" }),
      ).toThrow(InvalidPermissionChoiceError);
      expect(manager.getPending(pending.id)).toBeDefined();
      manager.respond("child", pending.id, { type: "once" });
      await expect(response).resolves.toBe("once");
    } finally {
      manager.dispose();
    }
  });
  it("keeps deny priority and treats missing trusted analysis conservatively", async () => {
    const state = createPermissionState({ bus: createBus() });
    state.addSessionRule("child", {
      tool: "bash",
      pattern: "*",
      decision: "allow",
      scope: "session",
    });
    const missing = {
      ...identity,
      params: { command: "ls", shellAnalysis: { completeness: "complete" } },
    };
    expect(evaluatePermission(missing, state.getState())).toMatchObject({
      type: "ask",
      rememberable: false,
    });
    state.addSessionRule("child", {
      tool: "bash",
      pattern: "ls",
      decision: "deny",
      scope: "session",
    });
    expect(evaluatePermission(missing, state.getState()).type).toBe("deny");
  });
  it("preserves only git and docker arity while ordinary and multi commands use whole patterns", async () => {
    for (const [command, expected] of [
      ["git status", "bash(git status *)"],
      ["docker ps", "bash(docker ps *)"],
      ["npm run test", "bash(npm run test)"],
      ["git status; npm run test", "bash(git status; npm run test)"],
    ]) {
      expect(
        generatePermissionPattern({
          type: "bash",
          name: "bash",
          params: { command },
          shellAnalysis: await analyzeShellCommand(command, "bash"),
        }),
      ).toBe(expected);
    }
  });
  it("does not auto approve an incomplete request when another request adds Always", async () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    let id = 0;
    const manager = createPermissionManager({
      bus,
      state,
      generateId: () => `permission-${++id}`,
    });
    try {
      const dynamic = manager.ask({
        ...identity,
        callId: "dynamic",
        params: { command: "git $(printf status)" },
        shellAnalysis: await analyzeShellCommand(
          "git $(printf status)",
          "bash",
        ),
      });
      const complete = manager.ask({
        ...identity,
        callId: "complete",
        params: { command: "git status" },
        shellAnalysis: await analyzeShellCommand("git status", "bash"),
      });
      manager.respond("child", "permission-2", { type: "always" });
      await expect(complete).resolves.toBe("always");
      expect(manager.getPending("permission-1")).toBeDefined();
      manager.respond("child", "permission-1", { type: "once" });
      await expect(dynamic).resolves.toBe("once");
    } finally {
      manager.dispose();
    }
  });
});
