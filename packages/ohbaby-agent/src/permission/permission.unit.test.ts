import { describe, expect, it } from "vitest";
import { createBus } from "../bus/index.js";
import {
  createPermissionManager,
  generatePermissionPattern,
  matchPermissionPattern,
  PermissionEvent,
  PermissionRejectedError,
  PermissionRejectedWithSuggestionError,
} from "./index.js";
import type { PermissionAskInput, PermissionInfo } from "./index.js";

function baseAskInput(
  overrides: Partial<PermissionAskInput> = {},
): PermissionAskInput {
  return {
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
        id: "permission_1",
        messageId: "message_1",
        name: "edit",
        pattern: "tool:edit:src/components/**",
        sessionId: "session_1",
        type: "tool",
      }),
    ]);

    permission.respond("session_1", "permission_1", { type: "once" });

    await expect(askPromise).resolves.toBe("once");
    expect(replied).toEqual([
      {
        permissionId: "permission_1",
        response: { type: "once" },
        sessionId: "session_1",
      },
    ]);
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

  it("records always approvals, auto-approves matching queued requests, and requests agent auto-edit", async () => {
    const bus = createBus();
    let nextId = 1;
    const permission = createPermissionManager({
      bus,
      generateId: () => `permission_${String(nextId++)}`,
    });
    const replied: unknown[] = [];
    const switchRequests: unknown[] = [];

    bus.subscribe(PermissionEvent.Replied, (event) => {
      replied.push(event);
    });
    bus.subscribe(PermissionEvent.SwitchModeRequested, (event) => {
      switchRequests.push(event);
    });

    const first = permission.ask(baseAskInput());
    const second = permission.ask(
      baseAskInput({
        messageId: "message_2",
        params: { file_path: "src/components/Card.tsx" },
      }),
    );

    permission.respond("session_1", "permission_1", { type: "always" });

    await expect(first).resolves.toBe("always");
    await expect(second).resolves.toBe("always");
    expect(replied).toEqual([
      {
        permissionId: "permission_1",
        response: { type: "always" },
        sessionId: "session_1",
      },
      {
        permissionId: "permission_2",
        response: {
          pattern: "tool:edit:src/components/**",
          type: "auto_approved",
        },
        sessionId: "session_1",
      },
    ]);
    expect(switchRequests).toEqual([
      {
        sessionId: "session_1",
        targetMode: "edit-automatically",
        trigger: {
          pattern: "tool:edit:src/components/**",
          permissionId: "permission_1",
        },
      },
    ]);

    await expect(
      permission.ask(
        baseAskInput({
          messageId: "message_3",
          params: { file_path: "src/components/Input.tsx" },
        }),
      ),
    ).resolves.toBe("always");
  });

  it("keeps approvals and cleanup scoped by session", async () => {
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

    const sessionA = permission.ask(baseAskInput({ sessionId: "session_a" }));
    permission.respond("session_a", "permission_1", { type: "always" });
    await expect(sessionA).resolves.toBe("always");

    const sessionB = permission.ask(baseAskInput({ sessionId: "session_b" }));
    await Promise.resolve();
    expect(updated.at(-1)?.sessionId).toBe("session_b");
    permission.respond("session_b", "permission_2", { type: "once" });
    await expect(sessionB).resolves.toBe("once");

    permission.clearSession("session_a");

    const afterClear = permission.ask(baseAskInput({ sessionId: "session_a" }));
    await Promise.resolve();
    expect(updated.at(-1)?.sessionId).toBe("session_a");
    permission.respond("session_a", "permission_3", { type: "once" });
    await expect(afterClear).resolves.toBe("once");
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
    ).toBe("tool:edit:src/components/**");
    expect(
      generatePermissionPattern({
        name: "git",
        params: { command: "git push origin main" },
        type: "bash",
      }),
    ).toBe("bash:git:push");
    expect(
      generatePermissionPattern({
        name: "code-review",
        params: {},
        type: "skill",
      }),
    ).toBe("skill:code-review");
    expect(
      generatePermissionPattern({
        name: "outside",
        params: {},
        type: "external_directory",
      }),
    ).toBe("external_directory:outside");
  });

  it("matches exact, wildcard, and parent directory approval patterns", () => {
    expect(
      matchPermissionPattern(
        "tool:edit:src/components/**",
        new Set(["tool:edit:src/components/**"]),
      ),
    ).toBe(true);
    expect(
      matchPermissionPattern("bash:git:push", new Set(["bash:git:*"])),
    ).toBe(true);
    expect(
      matchPermissionPattern(
        "tool:edit:src/components/Button.tsx",
        new Set(["tool:edit:src/**"]),
      ),
    ).toBe(true);
    expect(
      matchPermissionPattern(
        "tool:edit:tests/Button.tsx",
        new Set(["tool:edit:src/**"]),
      ),
    ).toBe(false);
  });
});
