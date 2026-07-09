import { describe, expect, it } from "vitest";
import { classifyPermissionCall } from "./classifier.js";
import type { PermissionCall } from "./types.js";

function call(
  toolName: string,
  params: Record<string, unknown> = {},
  category?: PermissionCall["category"],
): PermissionCall {
  return {
    callId: `call_${toolName}`,
    category,
    messageId: "message_1",
    params,
    sessionId: "session_1",
    toolName,
  };
}

describe("permission classifier", () => {
  it("classifies ordinary tool names and built-in categories", () => {
    expect(classifyPermissionCall(call("read"))).toMatchObject({
      category: "readonly",
    });
    expect(classifyPermissionCall(call("edit"))).toMatchObject({
      category: "write",
    });
    expect(classifyPermissionCall(call("write"))).toMatchObject({
      category: "write",
    });
    expect(classifyPermissionCall(call("web_search"))).toMatchObject({
      category: "network",
    });
  });

  it("splits memory read and write semantics without expanding the top-level enum", () => {
    expect(classifyPermissionCall(call("memory_read"))).toMatchObject({
      category: "memory",
      kind: "memory-read",
    });
    expect(classifyPermissionCall(call("memory_list"))).toMatchObject({
      category: "memory",
      kind: "memory-read",
    });
    expect(classifyPermissionCall(call("memory_add"))).toMatchObject({
      category: "memory",
      kind: "memory-write",
    });
    expect(classifyPermissionCall(call("memory_update"))).toMatchObject({
      category: "memory",
      kind: "memory-write",
    });
    expect(classifyPermissionCall(call("memory_remove"))).toMatchObject({
      category: "memory",
      kind: "memory-write",
    });
  });

  it("classifies subagent and skill tools", () => {
    expect(classifyPermissionCall(call("subagent_run"))).toMatchObject({
      category: "subagent",
      kind: "subagent",
    });
    expect(classifyPermissionCall(call("subagent_status"))).toMatchObject({
      category: "subagent",
      kind: "subagent",
    });
    expect(classifyPermissionCall(call("subagent_close"))).toMatchObject({
      category: "subagent",
      kind: "subagent",
    });
    expect(classifyPermissionCall(call("skill", { name: "review" }))).toEqual(
      expect.objectContaining({
        category: "skill",
        kind: "skill",
        label: "review",
      }),
    );
  });

  it("classifies synthetic sensitive path prompts explicitly", () => {
    expect(classifyPermissionCall(call("Sensitive_Path"))).toMatchObject({
      category: "dangerous",
      kind: "sensitive",
    });
  });

  it("delegates bash commands to shell command classification", () => {
    expect(
      classifyPermissionCall(call("bash", { command: "git status" })),
    ).toMatchObject({
      bash: "readonly",
      category: "dangerous",
      kind: "bash-readonly",
    });
    expect(
      classifyPermissionCall(call("bash", { command: "npm install" })),
    ).toMatchObject({
      bash: "mutating",
      category: "dangerous",
      kind: "bash-mutating",
    });
    expect(
      classifyPermissionCall(call("bash", { command: "rm -rf foo" })),
    ).toMatchObject({
      bash: "dangerous",
      category: "dangerous",
      kind: "bash-dangerous",
    });
  });

  it("treats unknown tools conservatively as write-like", () => {
    expect(classifyPermissionCall(call("custom_tool"))).toMatchObject({
      category: "write",
      kind: "write",
    });
  });

  it("does not infer bash semantics from a non-bash tool command parameter", () => {
    expect(
      classifyPermissionCall(call("custom_tool", { command: "deploy prod" })),
    ).toMatchObject({
      category: "write",
      kind: "write",
    });
  });
});
