import { describe, expect, it } from "vitest";
import { evaluatePermission } from "./evaluator.js";
import type {
  Level,
  Mode,
  PermissionCall,
  PermissionRule,
  PermissionState,
} from "./types.js";

function state(input: {
  readonly mode: Mode;
  readonly level: Level;
  readonly rules?: readonly PermissionRule[];
  readonly sessionId?: string;
}): PermissionState {
  return {
    level: input.level,
    mode: input.mode,
    sessionRules: new Map(
      input.rules ? [[input.sessionId ?? "session_1", input.rules]] : [],
    ),
  };
}

function call(
  toolName: string,
  params: Record<string, unknown> = {},
  sessionId = "session_1",
): PermissionCall {
  return {
    callId: `call_${toolName}`,
    messageId: "message_1",
    params,
    sessionId,
    toolName,
  };
}

function rule(input: {
  readonly tool: string;
  readonly pattern?: string;
  readonly decision?: "allow" | "deny";
  readonly reason?: string;
}): PermissionRule {
  return {
    decision: input.decision ?? "allow",
    pattern: input.pattern,
    reason: input.reason,
    scope: "session",
    tool: input.tool,
  };
}

describe("permission evaluator", () => {
  it.each([
    ["plan", "default", call("read", { file_path: "src/a.ts" }), "allow"],
    ["plan", "full-access", call("edit", { file_path: "src/a.ts" }), "allow"],
    ["plan", "default", call("bash", { command: "ls" }), "ask"],
    ["plan", "full-access", call("bash", { command: "mkdir tmp" }), "allow"],
    ["plan", "default", call("memory_read"), "allow"],
    ["plan", "full-access", call("memory_add"), "allow"],
    ["plan", "default", call("todo_write", { todos: [] }), "allow"],
    ["plan", "default", call("subagent_run"), "allow"],
    ["plan", "default", call("skill", { name: "review" }), "ask"],
    ["plan", "full-access", call("skill", { name: "review" }), "allow"],
    ["auto", "default", call("read", { file_path: "src/a.ts" }), "allow"],
    ["auto", "default", call("edit", { file_path: "src/a.ts" }), "ask"],
    ["auto", "full-access", call("edit", { file_path: "src/a.ts" }), "allow"],
    ["auto", "default", call("bash", { command: "git status" }), "ask"],
    ["auto", "default", call("bash", { command: "npm install" }), "ask"],
    ["auto", "default", call("bash", { command: "rm -rf foo" }), "ask"],
    ["auto", "full-access", call("bash", { command: "rm -rf foo" }), "allow"],
    ["auto", "full-access", call("sensitive_path"), "ask"],
    ["auto", "full-access", call("external_directory"), "allow"],
    ["auto", "default", call("memory_add"), "allow"],
    ["auto", "default", call("todo_write", { todos: [] }), "allow"],
    ["auto", "default", call("subagent_run"), "allow"],
    ["auto", "default", call("skill", { name: "review" }), "ask"],
    ["auto", "full-access", call("skill", { name: "review" }), "allow"],
  ] as const)(
    "mode=%s level=%s call=%j -> %s",
    (mode, level, permissionCall, expected) => {
      expect(
        evaluatePermission(permissionCall, state({ level, mode })).type,
      ).toBe(expected);
    },
  );

  it("includes actionable reasons for skill and shell asks", () => {
    const skillDecision = evaluatePermission(
      call("skill", { name: "review" }),
      state({ level: "default", mode: "auto" }),
    );
    expect(skillDecision.type).toBe("ask");
    expect(skillDecision.reason).toMatch(/review/);

    const bashDecision = evaluatePermission(
      call("bash", { command: "rm -rf foo" }),
      state({ level: "default", mode: "auto" }),
    );
    expect(bashDecision.type).toBe("ask");
    expect(bashDecision.reason).toMatch(/dangerous/i);
  });

  it("uses session rules before level fallback", () => {
    const allowSrc = rule({ pattern: "src/**", tool: "edit" });
    const denyRm = rule({
      decision: "deny",
      pattern: "rm *",
      reason: "blocked rm",
      tool: "bash",
    });

    expect(
      evaluatePermission(
        call("edit", { file_path: "src/a.ts" }),
        state({ level: "default", mode: "auto", rules: [allowSrc] }),
      ),
    ).toEqual({ type: "allow" });
    expect(
      evaluatePermission(
        call("edit", { file_path: "lib/a.ts" }),
        state({ level: "default", mode: "auto", rules: [allowSrc] }),
      ).type,
    ).toBe("ask");
    expect(
      evaluatePermission(
        call("bash", { command: "rm -rf foo" }),
        state({ level: "full-access", mode: "auto", rules: [denyRm] }),
      ),
    ).toEqual({ reason: "blocked rm", type: "deny" });
    expect(
      evaluatePermission(
        call("edit", { file_path: "src/a.ts" }),
        state({ level: "full-access", mode: "plan", rules: [allowSrc] }),
      ).type,
    ).toBe("allow");
  });

  it("does not let session allow rules bypass sensitive path confirmations", () => {
    const decision = evaluatePermission(
      call("sensitive_path", { path: "C:/Windows/System32/config/SAM" }),
      state({
        level: "full-access",
        mode: "auto",
        rules: [rule({ tool: "sensitive_path" })],
      }),
    );

    expect(decision).toMatchObject({
      rememberable: false,
      type: "ask",
    });
    expect(decision.reason).toMatch(/Sensitive path access/i);
  });

  it("keeps session rules isolated by session id", () => {
    const permissionState = state({
      level: "default",
      mode: "auto",
      rules: [rule({ pattern: "src/**", tool: "edit" })],
      sessionId: "session_a",
    });

    expect(
      evaluatePermission(
        call("edit", { file_path: "src/a.ts" }, "session_a"),
        permissionState,
      ).type,
    ).toBe("allow");
    expect(
      evaluatePermission(
        call("edit", { file_path: "src/a.ts" }, "session_b"),
        permissionState,
      ).type,
    ).toBe("ask");
  });
});
