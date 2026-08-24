import { describe, expect, it } from "vitest";
import { createScopedPromptCacheKey } from "../../core/llm-client/prompt-cache.js";
import type { ToolDefinition } from "../../core/tool-scheduler/index.js";
import { ScopeToolSequence } from "./tool-sequence.js";

function tool(name: string, description = name): ToolDefinition {
  return {
    category: "readonly",
    description,
    name,
    parameters: { properties: {}, type: "object" },
    source: name.startsWith("mcp_") ? "mcp" : "builtin",
  };
}

describe("scope tool sequence", () => {
  it("appends newly visible tools, keeps repeat loads idempotent, and tracks epochs", () => {
    const sequence = new ScopeToolSequence();
    const scope = { sessionId: "session_1" };

    const initial = sequence.snapshot(scope, [tool("read"), tool("bash")]);
    const withC = sequence.snapshot(scope, [
      tool("read"),
      tool("bash"),
      tool("mcp_c"),
    ]);
    const repeatedC = sequence.snapshot(scope, [
      tool("read"),
      tool("bash"),
      tool("mcp_c"),
    ]);
    const withD = sequence.snapshot(scope, [
      tool("read"),
      tool("bash"),
      tool("mcp_c"),
      tool("mcp_d"),
    ]);

    expect(initial.tools.map(({ name }) => name)).toEqual(["read", "bash"]);
    expect(initial.epoch).toBe(0);
    expect(withC.tools.map(({ name }) => name)).toEqual([
      "read",
      "bash",
      "mcp_c",
    ]);
    expect(withC.epoch).toBe(1);
    expect(repeatedC).toEqual(withC);
    expect(withD.tools.map(({ name }) => name)).toEqual([
      "read",
      "bash",
      "mcp_c",
      "mcp_d",
    ]);
    expect(withD.epoch).toBe(2);
  });

  it("isolates scopes and creates one epoch per changed visible prefix", () => {
    const sequence = new ScopeToolSequence();
    const first = { contextScopeId: "subagent_1", sessionId: "child" };
    const second = { contextScopeId: "subagent_2", sessionId: "child" };
    sequence.snapshot(first, [
      tool("read"),
      tool("bash"),
      tool("mcp_c"),
      tool("write"),
    ]);
    sequence.snapshot(second, [tool("read")]);

    const changed = sequence.snapshot(first, [
      tool("read", "changed"),
      tool("bash"),
      tool("write"),
    ]);
    const untouched = sequence.snapshot(second, [tool("read")]);

    expect(changed.tools).toEqual([
      tool("read", "changed"),
      tool("bash"),
      tool("write"),
    ]);
    expect(changed.epoch).toBe(1);
    expect(untouched.epoch).toBe(0);
  });

  it("keeps primary and subagent load order and epochs isolated", () => {
    const sequence = new ScopeToolSequence();
    const primary = { sessionId: "parent" };
    const child = { contextScopeId: "subagent_1", sessionId: "child" };

    sequence.snapshot(primary, [tool("read"), tool("mcp_primary")]);
    sequence.snapshot(child, [tool("read")]);
    const primaryNext = sequence.snapshot(primary, [
      tool("read"),
      tool("mcp_primary"),
      tool("mcp_primary_2"),
    ]);
    const childNext = sequence.snapshot(child, [
      tool("read"),
      tool("mcp_child"),
    ]);

    expect(primaryNext.tools.map(({ name }) => name)).toEqual([
      "read",
      "mcp_primary",
      "mcp_primary_2",
    ]);
    expect(childNext.tools.map(({ name }) => name)).toEqual([
      "read",
      "mcp_child",
    ]);
    expect(primaryNext.epoch).toBe(1);
    expect(childNext.epoch).toBe(1);
  });

  it("restarts a missing loaded set in a new local sequence and then stays stable", () => {
    const scope = { contextScopeId: "subagent_1", sessionId: "child" };
    const beforeRestart = new ScopeToolSequence();
    const loaded = beforeRestart.snapshot(scope, [
      tool("read"),
      tool("bash"),
      tool("mcp_c"),
    ]);

    const afterRestart = new ScopeToolSequence();
    const rebuilt = afterRestart.snapshot(scope, [tool("read"), tool("bash")]);
    const repeated = afterRestart.snapshot(scope, [tool("read"), tool("bash")]);
    const keyBefore = createScopedPromptCacheKey(scope);
    const keyAfter = createScopedPromptCacheKey(scope);

    expect(loaded.tools.map(({ name }) => name)).toEqual([
      "read",
      "bash",
      "mcp_c",
    ]);
    expect(rebuilt).toEqual({
      epoch: 0,
      tools: [tool("read"), tool("bash")],
    });
    expect(rebuilt.tools).not.toEqual(loaded.tools);
    expect(repeated).toEqual(rebuilt);
    expect(keyAfter).toBe(keyBefore);
  });

  it("returns a deeply immutable snapshot and cleans scope/session state", () => {
    const sequence = new ScopeToolSequence();
    const first = { contextScopeId: "subagent_1", sessionId: "child" };
    const second = { contextScopeId: "subagent_2", sessionId: "child" };
    const snapshot = sequence.snapshot(first, [tool("read")]);
    sequence.snapshot(second, [tool("bash")]);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tools)).toBe(true);
    expect(Object.isFrozen(snapshot.tools[0]?.parameters)).toBe(true);
    expect(() => {
      (snapshot.tools[0]?.parameters as { type?: string }).type = "array";
    }).toThrow();

    sequence.disposeScope("child", "subagent_1");
    expect(sequence.snapshot(first, [tool("read")]).epoch).toBe(0);
    expect(sequence.snapshot(second, [tool("bash")]).epoch).toBe(0);
    sequence.disposeSession("child");
    sequence.disposeSession("child");
    expect(sequence.snapshot(second, [tool("bash")]).epoch).toBe(0);
  });
});
