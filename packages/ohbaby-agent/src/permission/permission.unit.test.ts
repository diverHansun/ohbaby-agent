import { describe, expect, it } from "vitest";
import { createBus } from "../bus/index.js";
import {
  createPermissionManager,
  generatePermissionPattern,
  matchPermissionPattern,
  PermissionEvent,
  PermissionRejectedError,
  PermissionRejectedWithSuggestionError,
  createPermissionState,
} from "./index.js";
import type {
  PermissionAskInput,
  PermissionInfo,
  PermissionRule,
} from "./index.js";

function baseAskInput(
  overrides: Partial<PermissionAskInput> = {},
): PermissionAskInput {
  return {
    callId: "call_1",
    category: "write",
    messageId: "message_1",
    params: { file_path: "src/components/Button.tsx" },
    reason: "write requires approval",
    sessionId: "session_1",
    toolName: "edit",
    ...overrides,
  };
}

describe("PermissionManager", () => {
  it("publishes the first ask and keeps the promise pending until once response", async () => {
    const bus = createBus();
    const permission = createPermissionManager({
      bus,
      generateId: () => "permission_1",
      now: () => 100,
    });
    const updated: PermissionInfo[] = [];
    const replied: unknown[] = [];

    bus.subscribe(PermissionEvent.Updated, (event) => {
      updated.push(event.info);
    });
    bus.subscribe(PermissionEvent.Replied, (event) => {
      replied.push(event);
    });

    const askPromise = permission.ask(baseAskInput());
    let settled = false;
    void askPromise.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(updated).toEqual([
      expect.objectContaining({
        callId: "call_1",
        id: "permission_1",
        messageId: "message_1",
        name: "edit",
        pattern: "edit(src/components/**)",
        sessionId: "session_1",
        type: "tool",
      }),
    ]);

    permission.respond("session_1", "permission_1", { type: "once" });

    await expect(askPromise).resolves.toBe("once");
    expect(replied).toEqual([
      {
        callId: "call_1",
        permissionId: "permission_1",
        response: { type: "once" },
        sessionId: "session_1",
      },
    ]);
  });

  it("preserves callId in permission updates and replies", async () => {
    const bus = createBus();
    const permission = createPermissionManager({
      bus,
      generateId: () => "permission_1",
    });
    const updated: PermissionInfo[] = [];
    const replied: unknown[] = [];

    bus.subscribe(PermissionEvent.Updated, (event) => {
      updated.push(event.info);
    });
    bus.subscribe(PermissionEvent.Replied, (event) => {
      replied.push(event);
    });

    const askPromise = permission.ask(baseAskInput({ callId: "call_1" }));

    expect(updated.at(-1)?.callId).toBe("call_1");

    permission.respond("session_1", "permission_1", { type: "once" });

    await expect(askPromise).resolves.toBe("once");
    expect(replied).toEqual([
      {
        callId: "call_1",
        permissionId: "permission_1",
        response: { type: "once" },
        sessionId: "session_1",
      },
    ]);
  });

  it("uses the requested skill name when asking for skill permissions", async () => {
    const bus = createBus();
    const permission = createPermissionManager({
      bus,
      generateId: () => "permission_skill",
      now: () => 100,
    });
    const updated: PermissionInfo[] = [];

    bus.subscribe(PermissionEvent.Updated, (event) => {
      updated.push(event.info);
    });

    void permission.ask(
      baseAskInput({
        category: "skill",
        params: { name: "code-review" },
        reason: "Skill requires confirmation: code-review",
        toolName: "skill",
      }),
    );
    await Promise.resolve();

    expect(updated).toEqual([
      expect.objectContaining({
        name: "code-review",
        pattern: "skill(code-review)",
        title: "Skill requires confirmation: code-review",
        type: "skill",
      }),
    ]);
  });

  it("uses per-skill permission patterns for skill-category resource tools", async () => {
    const bus = createBus();
    const permission = createPermissionManager({
      bus,
      generateId: () => "permission_skill_resource",
      now: () => 100,
    });
    const updated: PermissionInfo[] = [];

    bus.subscribe(PermissionEvent.Updated, (event) => {
      updated.push(event.info);
    });

    void permission.ask(
      baseAskInput({
        category: "skill",
        params: { name: "docs", path: "references/guide.md" },
        reason: "Skill requires confirmation: docs",
        toolName: "skill_resource",
      }),
    );
    await Promise.resolve();

    expect(updated).toEqual([
      expect.objectContaining({
        name: "docs",
        pattern: "skill(docs)",
        title: "Skill requires confirmation: docs",
        type: "skill",
      }),
    ]);
  });

  it("records always skill approvals as session rules without changing mode or level", async () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    const permission = createPermissionManager({
      bus,
      generateId: () => "permission_skill",
      state,
    });
    const rules: unknown[] = [];
    bus.subscribe(PermissionEvent.RuleAdded, (event) => {
      rules.push(event);
    });

    const askPromise = permission.ask(
      baseAskInput({
        category: "skill",
        params: { name: "code-review" },
        reason: "Skill requires confirmation: code-review",
        toolName: "skill",
      }),
    );
    await Promise.resolve();

    permission.respond("session_1", "permission_skill", { type: "always" });

    await expect(askPromise).resolves.toBe("always");
    expect(state.getMode()).toBe("auto");
    expect(state.getLevel()).toBe("default");
    expect(state.getSessionRules("session_1")).toEqual([
      {
        decision: "allow",
        pattern: "code-review",
        scope: "session",
        tool: "skill",
      } satisfies PermissionRule,
    ]);
    expect(rules).toEqual([
      {
        rule: {
          decision: "allow",
          pattern: "code-review",
          scope: "session",
          tool: "skill",
        },
        sessionId: "session_1",
      },
    ]);
    await expect(
      permission.ask(
        baseAskInput({
          category: "skill",
          messageId: "message_2",
          params: { name: "code-review" },
          reason: "Skill requires confirmation: code-review",
          toolName: "skill",
        }),
      ),
    ).resolves.toBe("always");
  });

  it("serializes asks and publishes the next request only after the first resolves", async () => {
    const bus = createBus();
    let nextId = 1;
    const permission = createPermissionManager({
      bus,
      generateId: () => `permission_${String(nextId++)}`,
    });
    const updated: PermissionInfo[] = [];

    bus.subscribe(PermissionEvent.Updated, (event) => {
      updated.push(event.info);
    });

    const first = permission.ask(baseAskInput());
    const second = permission.ask(
      baseAskInput({
        callId: "call_2",
        messageId: "message_2",
        params: { file_path: "src/components/Card.tsx" },
      }),
    );

    await Promise.resolve();
    expect(updated.map((info) => info.id)).toEqual(["permission_1"]);

    permission.respond("session_1", "permission_1", { type: "once" });
    await expect(first).resolves.toBe("once");

    expect(updated.map((info) => info.id)).toEqual([
      "permission_1",
      "permission_2",
    ]);

    permission.respond("session_1", "permission_2", { type: "once" });
    await expect(second).resolves.toBe("once");
  });

  it("rejects with structured errors for reject, suggest, and cancel", async () => {
    let nextId = 1;
    const permission = createPermissionManager({
      bus: createBus(),
      generateId: () => `permission_${String(nextId++)}`,
    });

    const rejected = permission.ask(baseAskInput());
    permission.respond("session_1", "permission_1", { type: "reject" });
    await expect(rejected).rejects.toBeInstanceOf(PermissionRejectedError);

    const suggested = permission.ask(baseAskInput());
    permission.respond("session_1", "permission_2", {
      suggestion: "Use read first",
      type: "suggest",
    });
    await expect(suggested).rejects.toMatchObject({
      name: "PermissionRejectedWithSuggestionError",
      suggestion: "Use read first",
    } satisfies Partial<PermissionRejectedWithSuggestionError>);

    const cancelled = permission.ask(baseAskInput());
    permission.respond("session_1", "permission_3", { type: "cancel" });
    await expect(cancelled).resolves.toBe("cancel");
  });

  it("records always session rules and drains matching queued requests", async () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    let nextId = 1;
    const permission = createPermissionManager({
      bus,
      generateId: () => `permission_${String(nextId++)}`,
      state,
    });
    const replied: unknown[] = [];
    const rules: unknown[] = [];

    bus.subscribe(PermissionEvent.Replied, (event) => {
      replied.push(event);
    });
    bus.subscribe(PermissionEvent.RuleAdded, (event) => {
      rules.push(event);
    });

    const first = permission.ask(baseAskInput());
    const second = permission.ask(
      baseAskInput({
        callId: "call_2",
        messageId: "message_2",
        params: { file_path: "src/components/Card.tsx" },
      }),
    );

    permission.respond("session_1", "permission_1", { type: "always" });

    await expect(first).resolves.toBe("always");
    await expect(second).resolves.toBe("always");
    expect(replied).toEqual([
      {
        callId: "call_1",
        permissionId: "permission_1",
        response: {
          pattern: "edit(src/components/**)",
          type: "always",
        },
        sessionId: "session_1",
      },
      {
        callId: "call_2",
        permissionId: "permission_2",
        response: {
          pattern: "edit(src/components/**)",
          type: "auto_approved",
        },
        sessionId: "session_1",
      },
    ]);
    expect(state.getSessionRules("session_1")).toEqual([
      {
        decision: "allow",
        pattern: "src/components/**",
        scope: "session",
        tool: "edit",
      },
    ]);
    expect(rules).toHaveLength(1);

    await expect(
      permission.ask(
        baseAskInput({
          callId: "call_3",
          messageId: "message_3",
          params: { file_path: "src/components/Input.tsx" },
        }),
      ),
    ).resolves.toBe("always");
  });

  it("does not remember non-rememberable confirmations or drain matching queued requests", async () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    let nextId = 1;
    const permission = createPermissionManager({
      bus,
      generateId: () => `permission_${String(nextId++)}`,
      state,
    });
    const replied: unknown[] = [];
    const updated: PermissionInfo[] = [];

    bus.subscribe(PermissionEvent.Updated, (event) => {
      updated.push(event.info);
    });
    bus.subscribe(PermissionEvent.Replied, (event) => {
      replied.push(event);
    });

    const first = permission.ask(baseAskInput({ rememberable: false }));
    const second = permission.ask(
      baseAskInput({
        callId: "call_2",
        messageId: "message_2",
        rememberable: false,
      }),
    );

    permission.respond("session_1", "permission_1", { type: "always" });

    await expect(first).resolves.toBe("once");
    expect(state.getSessionRules("session_1")).toEqual([]);
    expect(updated.map((info) => info.id)).toEqual([
      "permission_1",
      "permission_2",
    ]);

    permission.respond("session_1", "permission_2", { type: "once" });
    await expect(second).resolves.toBe("once");
    expect(replied).toEqual([
      {
        callId: "call_1",
        permissionId: "permission_1",
        response: { type: "once" },
        sessionId: "session_1",
      },
      {
        callId: "call_2",
        permissionId: "permission_2",
        response: { type: "once" },
        sessionId: "session_1",
      },
    ]);
  });

  it("does not auto-approve queued requests marked as non-rememberable", async () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    let nextId = 1;
    const permission = createPermissionManager({
      bus,
      generateId: () => `permission_${String(nextId++)}`,
      state,
    });
    const replied: unknown[] = [];
    const updated: PermissionInfo[] = [];

    bus.subscribe(PermissionEvent.Updated, (event) => {
      updated.push(event.info);
    });
    bus.subscribe(PermissionEvent.Replied, (event) => {
      replied.push(event);
    });

    const first = permission.ask(baseAskInput());
    const second = permission.ask(
      baseAskInput({
        callId: "call_2",
        messageId: "message_2",
        rememberable: false,
      }),
    );

    permission.respond("session_1", "permission_1", { type: "always" });

    await expect(first).resolves.toBe("always");
    expect(updated.map((info) => info.id)).toEqual([
      "permission_1",
      "permission_2",
    ]);

    permission.respond("session_1", "permission_2", { type: "once" });
    await expect(second).resolves.toBe("once");
    expect(replied).toEqual([
      {
        callId: "call_1",
        permissionId: "permission_1",
        response: {
          pattern: "edit(src/components/**)",
          type: "always",
        },
        sessionId: "session_1",
      },
      {
        callId: "call_2",
        permissionId: "permission_2",
        response: { type: "once" },
        sessionId: "session_1",
      },
    ]);
  });

  it("rechecks evaluator state before auto-approving queued matching requests", async () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    let nextId = 1;
    const permission = createPermissionManager({
      bus,
      generateId: () => `permission_${String(nextId++)}`,
      state,
    });
    const updated: PermissionInfo[] = [];

    bus.subscribe(PermissionEvent.Updated, (event) => {
      updated.push(event.info);
    });

    const first = permission.ask(baseAskInput());
    const second = permission.ask(
      baseAskInput({
        callId: "call_2",
        messageId: "message_2",
      }),
    );
    state.setMode("plan");

    permission.respond("session_1", "permission_1", { type: "always" });

    await expect(first).resolves.toBe("always");
    expect(updated.map((info) => info.id)).toEqual([
      "permission_1",
      "permission_2",
    ]);

    permission.respond("session_1", "permission_2", { type: "once" });
    await expect(second).resolves.toBe("once");
  });

  it("keeps approvals and cleanup scoped by session", async () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    let nextId = 1;
    const permission = createPermissionManager({
      bus,
      generateId: () => `permission_${String(nextId++)}`,
      state,
    });
    const updated: PermissionInfo[] = [];

    bus.subscribe(PermissionEvent.Updated, (event) => {
      updated.push(event.info);
    });

    const sessionA = permission.ask(baseAskInput({ sessionId: "session_a" }));
    permission.respond("session_a", "permission_1", { type: "always" });
    await expect(sessionA).resolves.toBe("always");

    const sessionB = permission.ask(
      baseAskInput({ callId: "call_2", sessionId: "session_b" }),
    );
    await Promise.resolve();
    expect(updated.at(-1)?.sessionId).toBe("session_b");
    permission.respond("session_b", "permission_2", { type: "once" });
    await expect(sessionB).resolves.toBe("once");

    permission.clearSession("session_a");

    const afterClear = permission.ask(
      baseAskInput({ callId: "call_3", sessionId: "session_a" }),
    );
    await Promise.resolve();
    expect(updated.at(-1)?.sessionId).toBe("session_a");
    permission.respond("session_a", "permission_3", { type: "once" });
    await expect(afterClear).resolves.toBe("once");
  });

  it("downgrades always responses for write tools without a scoped path", async () => {
    const bus = createBus();
    let nextId = 1;
    const permission = createPermissionManager({
      bus,
      generateId: () => `permission_${String(nextId++)}`,
    });
    const updated: PermissionInfo[] = [];
    const replied: unknown[] = [];

    bus.subscribe(PermissionEvent.Updated, (event) => {
      updated.push(event.info);
    });
    bus.subscribe(PermissionEvent.Replied, (event) => {
      replied.push(event);
    });

    const first = permission.ask(baseAskInput({ params: {} }));
    permission.respond("session_1", "permission_1", { type: "always" });

    await expect(first).resolves.toBe("once");
    expect(replied).toEqual([
      {
        callId: "call_1",
        permissionId: "permission_1",
        response: { type: "once" },
        sessionId: "session_1",
      },
    ]);

    const second = permission.ask(
      baseAskInput({ messageId: "message_2", params: {} }),
    );

    expect(updated.map((info) => info.id)).toEqual([
      "permission_1",
      "permission_2",
    ]);

    permission.respond("session_1", "permission_2", { type: "once" });
    await expect(second).resolves.toBe("once");
  });

  it("publishes cancel replies when clearing a session", async () => {
    const bus = createBus();
    let nextId = 1;
    const permission = createPermissionManager({
      bus,
      generateId: () => `permission_${String(nextId++)}`,
    });
    const replied: unknown[] = [];

    bus.subscribe(PermissionEvent.Replied, (event) => {
      replied.push(event);
    });

    const current = permission.ask(baseAskInput({ callId: "call_1" }));
    const queued = permission.ask(
      baseAskInput({ callId: "call_2", messageId: "message_2" }),
    );

    permission.clearSession("session_1");

    await expect(current).resolves.toBe("cancel");
    await expect(queued).resolves.toBe("cancel");
    expect(replied).toEqual([
      {
        callId: "call_1",
        permissionId: "permission_1",
        response: { type: "cancel" },
        sessionId: "session_1",
      },
      {
        callId: "call_2",
        permissionId: "permission_2",
        response: { type: "cancel" },
        sessionId: "session_1",
      },
    ]);
  });

  it("can cancel only pending asks while preserving session approvals", async () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    let nextId = 1;
    const permission = createPermissionManager({
      bus,
      generateId: () => `permission_${String(nextId++)}`,
      state,
    });

    const approved = permission.ask(baseAskInput());
    permission.respond("session_1", "permission_1", { type: "always" });
    await expect(approved).resolves.toBe("always");

    const pending = permission.ask(
      baseAskInput({
        callId: "call_2",
        messageId: "message_2",
        params: { file_path: "docs/blocked.txt" },
      }),
    );
    permission.cancelPending("session_1");
    await expect(pending).resolves.toBe("cancel");

    await expect(
      permission.ask(
        baseAskInput({
          callId: "call_3",
          messageId: "message_3",
          params: { file_path: "src/components/Input.tsx" },
        }),
      ),
    ).resolves.toBe("always");
  });
});

describe("permission patterns", () => {
  it("generates patterns for tool, bash, skill, and fallback requests", () => {
    expect(
      generatePermissionPattern({
        name: "edit",
        params: { file_path: "src/components/Button.tsx" },
        type: "tool",
      }),
    ).toBe("edit(src/components/**)");
    expect(
      generatePermissionPattern({
        name: "git",
        params: { command: "git push origin main" },
        type: "bash",
      }),
    ).toBe("bash(git push *)");
    expect(
      generatePermissionPattern({
        name: "code-review",
        params: {},
        type: "skill",
      }),
    ).toBe("skill(code-review)");
    expect(
      generatePermissionPattern({
        name: "outside",
        params: {},
        type: "external_directory",
      }),
    ).toBe("external_directory(outside)");
  });

  it("does not let an always git status approval auto-approve git push", async () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    const permission = createPermissionManager({
      bus,
      generateId: (() => {
        let nextId = 1;
        return (): string => `permission_${String(nextId++)}`;
      })(),
      state,
    });
    const updated: PermissionInfo[] = [];
    bus.subscribe(PermissionEvent.Updated, (event) => {
      updated.push(event.info);
    });

    const first = permission.ask(
      baseAskInput({
        category: "dangerous",
        params: { command: "git status" },
        toolName: "bash",
      }),
    );
    permission.respond("session_1", "permission_1", { type: "always" });
    await expect(first).resolves.toBe("always");
    expect(state.getSessionRules("session_1")).toEqual([
      {
        decision: "allow",
        pattern: "git status *",
        scope: "session",
        tool: "bash",
      } satisfies PermissionRule,
    ]);

    const second = permission.ask(
      baseAskInput({
        callId: "call_2",
        category: "dangerous",
        messageId: "message_2",
        params: { command: "git push origin main" },
        toolName: "bash",
      }),
    );
    let settled = false;
    void second.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(updated.at(-1)).toMatchObject({
      id: "permission_2",
      pattern: "bash(git push *)",
      type: "bash",
    });

    permission.respond("session_1", "permission_2", { type: "once" });
    await expect(second).resolves.toBe("once");
  });

  it("uses root-relative arity for wrapped git command approvals", async () => {
    expect(
      generatePermissionPattern({
        name: "bash",
        params: { command: "sudo git status" },
        type: "bash",
      }),
    ).toBe("bash(git status *)");
    expect(
      generatePermissionPattern({
        name: "bash",
        params: { command: "env FOO=bar git status" },
        type: "bash",
      }),
    ).toBe("bash(git status *)");
    expect(
      generatePermissionPattern({
        name: "bash",
        params: { command: "command git status" },
        type: "bash",
      }),
    ).toBe("bash(git status *)");

    const bus = createBus();
    const state = createPermissionState({ bus });
    const permission = createPermissionManager({
      bus,
      generateId: (() => {
        let nextId = 1;
        return (): string => `permission_${String(nextId++)}`;
      })(),
      state,
    });

    const first = permission.ask(
      baseAskInput({
        category: "dangerous",
        params: { command: "sudo git status" },
        toolName: "bash",
      }),
    );
    permission.respond("session_1", "permission_1", { type: "always" });
    await expect(first).resolves.toBe("always");
    expect(state.getSessionRules("session_1")).toEqual([
      {
        decision: "allow",
        pattern: "git status *",
        scope: "session",
        tool: "bash",
      } satisfies PermissionRule,
    ]);

    const sudoRm = permission.ask(
      baseAskInput({
        callId: "call_2",
        category: "dangerous",
        messageId: "message_2",
        params: { command: "sudo rm -rf /" },
        toolName: "bash",
      }),
    );
    let sudoRmSettled = false;
    void sudoRm.then(() => {
      sudoRmSettled = true;
    });
    await Promise.resolve();
    expect(sudoRmSettled).toBe(false);
    permission.respond("session_1", "permission_2", { type: "once" });
    await expect(sudoRm).resolves.toBe("once");

    const wrappedPush = permission.ask(
      baseAskInput({
        callId: "call_3",
        category: "dangerous",
        messageId: "message_3",
        params: { command: "env FOO=bar git push origin main" },
        toolName: "bash",
      }),
    );
    let wrappedPushSettled = false;
    void wrappedPush.then(() => {
      wrappedPushSettled = true;
    });
    await Promise.resolve();
    expect(wrappedPushSettled).toBe(false);
    permission.respond("session_1", "permission_3", { type: "once" });
    await expect(wrappedPush).resolves.toBe("once");
  });

  it("matches exact, wildcard, and parent directory approval patterns", () => {
    expect(
      matchPermissionPattern(
        "edit(src/components/**)",
        new Set(["edit(src/components/**)"]),
      ),
    ).toBe(true);
    expect(
      matchPermissionPattern("bash(git status)", new Set(["bash(git *)"])),
    ).toBe(true);
    expect(
      matchPermissionPattern(
        "edit(src/components/button.tsx)",
        new Set(["edit(src/**)"]),
      ),
    ).toBe(true);
    expect(
      matchPermissionPattern(
        "edit(tests/button.tsx)",
        new Set(["edit(src/**)"]),
      ),
    ).toBe(false);
    expect(
      matchPermissionPattern(
        generatePermissionPattern({
          name: "rm",
          params: { command: "rm -rf /" },
          type: "bash",
        }),
        new Set([
          generatePermissionPattern({
            name: "rm",
            params: { command: "rm -rf ./tmp" },
            type: "bash",
          }),
        ]),
      ),
    ).toBe(false);
  });
});
