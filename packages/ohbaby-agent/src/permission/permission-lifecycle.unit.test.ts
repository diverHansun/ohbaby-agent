import { describe, expect, it, vi } from "vitest";
import { createBus } from "../bus/index.js";
import {
  createPermissionManager,
  createPermissionState,
  PermissionEvent,
} from "./index.js";
import type {
  PermissionAskInput,
  PermissionCommit,
  PermissionResponse,
  PermissionManager,
  PermissionStateStore,
} from "./types.js";

function input(
  overrides: Partial<PermissionAskInput> = {},
): PermissionAskInput {
  return {
    sessionId: "child",
    runId: "run-a",
    callId: "call-a",
    messageId: "msg-a",
    source: { rootSessionId: "root", ancestorSessionIds: ["root"] },
    signal: new AbortController().signal,
    toolName: "edit",
    category: "write",
    params: { file_path: "src/a.ts" },
    ...overrides,
  };
}
function harness(
  extra: Partial<Parameters<typeof createPermissionManager>[0]> = {},
): {
  manager: PermissionManager;
  bus: ReturnType<typeof createBus>;
  state: PermissionStateStore;
  commits: PermissionCommit[];
} {
  const bus = createBus();
  const state = createPermissionState({ bus });
  const commits: PermissionCommit[] = [];
  let id = 0;
  const manager = createPermissionManager({
    bus,
    state,
    generateId: () => `p${String(++id)}`,
    criticalCommit: (event) => {
      commits.push(event);
    },
    ...extra,
  });
  return { manager, bus, state, commits };
}

describe("permission lifecycle", () => {
  it("publishes all requests and lets a later request finish independently", async () => {
    const { manager, commits } = harness();
    const a = manager.ask(input());
    const b = manager.ask(input({ callId: "call-b" }));
    expect(commits.map((e) => e.type)).toEqual(["requested", "requested"]);
    expect(manager.respond("child", "p2", { type: "once" })).toBe("accepted");
    await expect(b).resolves.toBe("once");
    expect(manager.listPending().map((i) => i.id)).toEqual(["p1"]);
    const rejected = expect(a).rejects.toThrow("Permission rejected");
    manager.respond("child", "p1", { type: "reject" });
    await rejected;
  });

  it("answers the last request across two roots and multiple sources without settling the others", async () => {
    const { manager, commits } = harness();
    const settled: string[] = [];
    const identities = [
      ["root-a", "root-a"],
      ["child-a", "root-a"],
      ["root-b", "root-b"],
      ["child-b", "root-b"],
    ];
    const waits = identities.map(([sessionId, rootSessionId], index) =>
      manager
        .ask(
          input({
            sessionId,
            runId: `run-${String(index)}`,
            callId: `call-${String(index)}`,
            messageId: `message-${String(index)}`,
            source: {
              rootSessionId,
              ancestorSessionIds:
                sessionId === rootSessionId ? [] : [rootSessionId],
            },
          }),
        )
        .then((response) => {
          settled.push(sessionId);
          return response;
        }),
    );
    expect(commits.filter((event) => event.type === "requested")).toHaveLength(
      4,
    );
    expect(manager.respond("child-b", "p4", { type: "once" })).toBe("accepted");
    await expect(waits[3]).resolves.toBe("once");
    expect(settled).toEqual(["child-b"]);
    expect(
      manager.listPending().map(({ id, sessionId, rootSessionId }) => ({
        id,
        sessionId,
        rootSessionId,
      })),
    ).toEqual([
      { id: "p1", sessionId: "root-a", rootSessionId: "root-a" },
      { id: "p2", sessionId: "child-a", rootSessionId: "root-a" },
      { id: "p3", sessionId: "root-b", rootSessionId: "root-b" },
    ]);
    expect(commits.filter((event) => event.type === "resolved")).toHaveLength(
      1,
    );
    manager.dispose();
    await expect(Promise.all(waits)).resolves.toEqual([
      "cancel",
      "cancel",
      "cancel",
      "once",
    ]);
  });

  it.each(["cancel", "unknown", "always"])(
    "invalid %s never consumes a nonrememberable request",
    async (type) => {
      const { manager, state } = harness();
      const pending = manager.ask(input({ rememberable: false }));
      expect(() =>
        manager.respond("child", "p1", { type } as PermissionResponse),
      ).toThrow("INVALID_PERMISSION_CHOICE");
      expect(manager.listPending()).toHaveLength(1);
      expect(state.getSessionRules("child")).toEqual([]);
      manager.respond("child", "p1", { type: "once" });
      await expect(pending).resolves.toBe("once");
    },
  );

  it("abort wins over late always without creating a rule", async () => {
    const { manager, state, commits } = harness();
    const controller = new AbortController();
    const pending = manager.ask(input({ signal: controller.signal }));
    controller.abort();
    expect(manager.respond("child", "p1", { type: "always" })).toBe("revoked");
    await expect(pending).resolves.toBe("cancel");
    expect(state.getSessionRules("child")).toEqual([]);
    expect(commits.map((e) => e.type)).toEqual(["requested", "resolved"]);
  });

  it("does not register or auto-approve an already cancelled call", async () => {
    const { manager, state, commits } = harness();
    state.addSessionRule("child", {
      tool: "edit",
      pattern: "src/**",
      decision: "allow",
      scope: "session",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      manager.ask(input({ signal: controller.signal })),
    ).resolves.toBe("cancel");
    expect(commits).toEqual([]);
    expect(manager.listPending()).toEqual([]);
  });

  it("scopes cleanup to real runs and the frozen ancestor path", async () => {
    const { manager } = harness();
    const a = manager.ask(input());
    const b = manager.ask(input({ runId: "run-b" }));
    manager.revokeByRun("run-a", "completed");
    await expect(a).resolves.toBe("cancel");
    expect(manager.listPending().map((i) => i.runId)).toEqual(["run-b"]);
    manager.revokeBySession("root", "deleted");
    await expect(b).resolves.toBe("cancel");
    expect(manager.listPending()).toEqual([]);
  });

  it.each([
    [
      "run",
      (manager: PermissionManager): void => {
        manager.revokeByRun("run-a", "ended");
      },
    ],
    [
      "source",
      (manager: PermissionManager): void => {
        manager.revokeBySession("child", "deleted");
      },
    ],
    [
      "ancestor",
      (manager: PermissionManager): void => {
        manager.revokeBySession("middle", "deleted");
      },
    ],
    [
      "root",
      (manager: PermissionManager): void => {
        manager.revokeBySession("root", "deleted");
      },
    ],
    [
      "cancel",
      (manager: PermissionManager): void => {
        manager.cancelPending("child");
      },
    ],
    [
      "clear",
      (manager: PermissionManager): void => {
        manager.clearSession("child");
      },
    ],
  ])(
    "makes the whole %s revocation scope ineligible before notifying observers",
    async (_name, revoke) => {
      let reentrantResponse: unknown;
      let reentrantAsk: ReturnType<PermissionManager["ask"]> | undefined;
      const scopedInput = input({
        source: {
          rootSessionId: "root",
          ancestorSessionIds: ["middle", "root"],
        },
      });
      const { manager, state, commits } = harness({
        onCommitted: (event) => {
          if (event.type !== "resolved" || event.identity.id !== "p1") return;
          reentrantResponse = manager.respond("child", "p2", {
            type: "always",
          });
          reentrantAsk = manager.ask({ ...scopedInput, callId: "late-call" });
          manager.respond("other", "p3", { type: "once" });
        },
      });
      const a = manager.ask(scopedInput);
      const b = manager.ask({ ...scopedInput, callId: "call-b" });
      const other = manager.ask(
        input({
          sessionId: "other",
          runId: "other-run",
          source: { rootSessionId: "other", ancestorSessionIds: [] },
        }),
      );
      revoke(manager);
      expect(reentrantResponse).toBe("revoked");
      expect(state.getSessionRules("child")).toEqual([]);
      expect(manager.listPending()).toEqual([]);
      await expect(Promise.all([a, b, reentrantAsk, other])).resolves.toEqual([
        "cancel",
        "cancel",
        "cancel",
        "once",
      ]);
      expect(
        commits
          .filter((event) => event.type === "resolved")
          .map((event) => event.identity.id)
          .sort(),
      ).toEqual(["p1", "p2", "p3"]);
    },
  );

  it("does not auto-approve a revoking run when another run remembers the same rule", async () => {
    const { manager, state } = harness({
      onCommitted: (event) => {
        if (event.type === "resolved" && event.identity.id === "p1")
          manager.respond("child", "p3", { type: "always" });
      },
    });
    const a = manager.ask(input());
    const b = manager.ask(input({ callId: "call-b" }));
    const otherRun = manager.ask(input({ runId: "run-b", callId: "call-c" }));
    manager.revokeByRun("run-a", "ended");
    await expect(Promise.all([a, b, otherRun])).resolves.toEqual([
      "cancel",
      "cancel",
      "always",
    ]);
    expect(state.getSessionRules("child")).toHaveLength(1);
    expect(manager.listPending()).toEqual([]);
  });

  it("keeps an outer cleanup scope guarded through nested cleanup and releases it afterward", async () => {
    let nestedAsk: ReturnType<PermissionManager["ask"]> | undefined;
    const { manager } = harness({
      onCommitted: (event) => {
        if (event.type !== "resolved") return;
        if (event.identity.id === "p1") manager.revokeByRun("run-b", "ended");
        if (event.identity.id === "p3")
          nestedAsk = manager.ask(input({ callId: "nested" }));
      },
    });
    const a = manager.ask(input());
    const b = manager.ask(input({ callId: "call-b" }));
    const other = manager.ask(input({ runId: "run-b", callId: "call-c" }));
    manager.revokeByRun("run-a", "ended");
    expect(manager.listPending()).toEqual([]);
    await expect(Promise.all([a, b, other, nestedAsk])).resolves.toEqual([
      "cancel",
      "cancel",
      "cancel",
      "cancel",
    ]);
    const later = manager.ask(input({ callId: "later" }));
    const pending = manager.listPending();
    expect(pending).toHaveLength(1);
    manager.respond("child", pending[0].id, { type: "once" });
    await expect(later).resolves.toBe("once");
  });

  it("keeps disposal closed to reentrant answers and asks while finishing every wait", async () => {
    let replyError: unknown;
    let askResult: Promise<unknown> | undefined;
    const { manager, state, commits } = harness({
      onCommitted: (event) => {
        if (event.type !== "resolved" || event.identity.id !== "p1") return;
        try {
          manager.respond("child", "p2", { type: "always" });
        } catch (error) {
          replyError = error;
        }
        askResult = manager
          .ask(input({ callId: "late" }))
          .catch((error: unknown) => error);
      },
    });
    const a = manager.ask(input());
    const b = manager.ask(input({ callId: "call-b" }));
    manager.dispose();
    await expect(Promise.all([a, b])).resolves.toEqual(["cancel", "cancel"]);
    expect(replyError).toMatchObject({ code: "PERMISSION_UNAVAILABLE" });
    expect(await askResult).toMatchObject({ code: "PERMISSION_UNAVAILABLE" });
    expect(state.getSessionRules("child")).toEqual([]);
    expect(manager.listPending()).toEqual([]);
    expect(commits.filter((event) => event.type === "resolved")).toHaveLength(
      2,
    );
  });

  it("continues bulk cleanup in healthy roots after a failed commit freezes one root", async () => {
    const commits: PermissionCommit[] = [];
    const { manager } = harness({
      criticalCommit: (event) => {
        if (event.type === "resolved" && event.identity.id === "p1")
          throw new Error("Broken projection");
        commits.push(event);
      },
    });
    const a = manager.ask(input()).catch((error: unknown) => error);
    const b = manager
      .ask(input({ callId: "call-b" }))
      .catch((error: unknown) => error);
    const other = manager.ask(
      input({
        sessionId: "other",
        source: { rootSessionId: "other", ancestorSessionIds: [] },
      }),
    );
    manager.revokeByRun("run-a", "ended");
    expect(await a).toMatchObject({ code: "PERMISSION_UNAVAILABLE" });
    expect(await b).toMatchObject({ code: "PERMISSION_UNAVAILABLE" });
    await expect(other).resolves.toBe("cancel");
    expect(manager.isHealthy("root")).toBe(false);
    expect(manager.isHealthy("other")).toBe(true);
    expect(manager.listPending()).toEqual([]);
    expect(
      commits
        .filter((event) => event.type === "resolved")
        .map((event) => event.identity.id),
    ).toEqual(["p3"]);
  });

  it("commits before rule notifications and tolerates reentrant and throwing observers", async () => {
    const { manager, state, bus, commits } = harness();
    const a = manager.ask(input());
    const b = manager.ask(input({ callId: "call-b" }));
    const observed: unknown[] = [];
    bus.subscribe(PermissionEvent.RuleAdded, () => {
      observed.push(commits.map((e) => e.type));
      observed.push(manager.respond("child", "p1", { type: "reject" }));
      throw new Error("observer failure");
    });
    manager.respond("child", "p1", { type: "always" });
    await expect(a).resolves.toBe("always");
    await expect(b).resolves.toBe("always");
    expect(observed).toEqual([
      ["requested", "requested", "resolved"],
      "already-resolved",
    ]);
    expect(state.getSessionRules("child")).toHaveLength(1);
    expect(commits.map((e) => e.type)).toEqual([
      "requested",
      "requested",
      "resolved",
      "resolved",
    ]);
    await expect(manager.ask(input())).resolves.toBe("always");
    expect(commits).toHaveLength(4);
  });

  it("freezes only a failed root and completes every affected wait even when projection is broken", async () => {
    let broken = false;
    const { manager, state } = harness({
      criticalCommit: () => {
        if (broken) throw new Error("broken projection");
        return true;
      },
    });
    const a = manager.ask(input());
    const aResult = expect(a).rejects.toThrow("PERMISSION_UNAVAILABLE");
    const b = manager.ask(input());
    const bResult = expect(b).rejects.toThrow("PERMISSION_UNAVAILABLE");
    const other = manager.ask(
      input({
        sessionId: "other",
        source: { rootSessionId: "other", ancestorSessionIds: [] },
      }),
    );
    broken = true;
    expect(() => manager.respond("child", "p1", { type: "always" })).toThrow(
      "PERMISSION_UNAVAILABLE",
    );
    await Promise.all([aResult, bResult]);
    expect(manager.isHealthy("root")).toBe(false);
    expect(state.getSessionRules("child")).toHaveLength(1);
    await expect(manager.ask(input())).rejects.toThrow(
      "PERMISSION_UNAVAILABLE",
    );
    broken = false;
    manager.respond("other", "p3", { type: "once" });
    await expect(other).resolves.toBe("once");
  });

  it("retains bounded terminal identities and checks source session before duplicate acceptance", async () => {
    const { manager } = harness({ terminalLimit: 1 });
    const a = manager.ask(input());
    manager.respond("child", "p1", { type: "once" });
    await a;
    expect(manager.respond("wrong", "p1", { type: "once" })).toBe(
      "not-pending",
    );
    expect(manager.getTerminal("p1")).toMatchObject({
      sessionId: "child",
      rootSessionId: "root",
      runId: "run-a",
      status: "resolved",
    });
    const b = manager.ask(input());
    manager.revoke("p2", "expired");
    await b;
    expect(manager.getTerminal("p1")).toBeUndefined();
    expect(manager.respond("child", "p1", { type: "always" })).toBe(
      "not-pending",
    );
  });

  it("freezes source identity, settles dispose, and prevents future registration", async () => {
    const { manager } = harness();
    const ancestors = ["root", "middle"];
    const pending = manager.ask(
      input({
        source: { rootSessionId: "root", ancestorSessionIds: ancestors },
      }),
    );
    ancestors.length = 0;
    expect(manager.getPending("p1")?.ancestorSessionIds).toEqual([
      "root",
      "middle",
    ]);
    manager.dispose();
    await expect(pending).resolves.toBe("cancel");
    await expect(manager.ask(input())).rejects.toThrow(
      "PERMISSION_UNAVAILABLE",
    );
  });

  it("honors latest deny rules even in the existing allow fast path and Full Access", async () => {
    const { manager, state, commits } = harness();
    state.addSessionRule("child", {
      tool: "edit",
      decision: "allow",
      scope: "session",
    });
    state.addSessionRule("child", {
      tool: "edit",
      decision: "deny",
      scope: "session",
    });
    state.setLevel("full-access");
    await expect(manager.ask(input())).rejects.toThrow();
    expect(commits).toEqual([]);
  });
  it.each([
    ["once", "once"],
    ["once", "reject"],
    ["reject", "once"],
    ["reject", "reject"],
  ] as const)("settles only the first %s/%s answer", async (first, second) => {
    const { manager, commits } = harness();
    const result = manager.ask(input()).then(
      (value) => value,
      () => "rejected",
    );
    expect(manager.respond("child", "p1", { type: first })).toBe("accepted");
    expect(manager.respond("child", "p1", { type: second })).toBe(
      "already-resolved",
    );
    expect(await result).toBe(first === "reject" ? "rejected" : "once");
    expect(commits.filter((event) => event.type === "resolved")).toHaveLength(
      1,
    );
  });

  it("does not broaden always to parents, siblings, nonrememberable or newly denied requests", async () => {
    const { manager, state } = harness();
    const first = manager.ask(input());
    const parent = manager.ask(
      input({
        sessionId: "root",
        source: { rootSessionId: "root", ancestorSessionIds: [] },
      }),
    );
    const sibling = manager.ask(input({ sessionId: "sibling" }));
    const explicit = manager.ask(input({ rememberable: false }));
    const denied = manager.ask(
      input({ params: { file_path: "src/private/a.ts" } }),
    );
    state.addSessionRule("child", {
      tool: "edit",
      pattern: "src/private/**",
      scope: "session",
      decision: "deny",
    });
    manager.respond("child", "p1", { type: "always" });
    await expect(first).resolves.toBe("always");
    expect(manager.listPending().map((info) => info.id)).toEqual([
      "p2",
      "p3",
      "p4",
      "p5",
    ]);
    expect(state.getSessionRules("root")).toEqual([]);
    expect(state.getSessionRules("sibling")).toEqual([]);
    expect(state.getLevel()).toBe("default");
    manager.dispose();
    await expect(
      Promise.all([parent, sibling, explicit, denied]),
    ).resolves.toEqual(["cancel", "cancel", "cancel", "cancel"]);
  });

  it("checks the latest policy before a direct approval and never adds an always rule for denied requests", async () => {
    const { manager, state } = harness();
    const pending = manager.ask(input());
    const rejected = expect(pending).rejects.toThrow("Permission rejected");
    state.addSessionRule("child", {
      tool: "edit",
      scope: "session",
      decision: "deny",
    });
    manager.respond("child", "p1", { type: "always" });
    await rejected;
    expect(state.getSessionRules("child").map((rule) => rule.decision)).toEqual(
      ["deny"],
    );
  });

  it("Full Access admits future requests without remembering rules and leaves existing pending unchanged", async () => {
    const { manager, state, commits } = harness();
    const pending = manager.ask(input());
    state.setLevel("full-access");
    await expect(
      manager.ask(
        input({
          toolName: "sensitive_path",
          category: "dangerous",
          rememberable: false,
        }),
      ),
    ).resolves.toBe("once");
    expect(manager.listPending().map((info) => info.id)).toEqual(["p1"]);
    expect(commits).toHaveLength(1);
    expect(state.getSessionRules("child")).toEqual([]);
    manager.revoke("p1", "ended");
    await pending;
  });

  it("rejects missing execution identity instead of synthesizing run IDs", async () => {
    const { manager, commits } = harness();
    await expect(manager.ask(input({ runId: "" }))).rejects.toThrow(
      "PERMISSION_INVALID_CONTEXT",
    );
    expect(commits).toEqual([]);
  });

  it("settles a failing registration without exposing requested and invalidates the affected scope", async () => {
    const unavailable: unknown[] = [];
    const { manager, bus } = harness({
      criticalCommit: () => {
        throw new Error("candidate failed");
      },
      onUnavailable: (root, error) => {
        unavailable.push([root, error.message]);
        throw new Error("notification failed");
      },
    });
    const published: unknown[] = [];
    bus.subscribe(PermissionEvent.Updated, (event) => {
      published.push(event);
    });
    await expect(manager.ask(input())).rejects.toThrow(
      "PERMISSION_UNAVAILABLE",
    );
    expect(manager.listPending()).toEqual([]);
    expect(published).toEqual([]);
    expect(unavailable).toEqual([
      ["root", expect.stringContaining("PERMISSION_UNAVAILABLE")],
    ]);
  });

  it("completes all waits when shared facilities fail, without affecting another manager", async () => {
    const { manager } = harness();
    const other = harness();
    const a = manager.ask(input()).catch((error: unknown) => error);
    const b = manager
      .ask(
        input({
          sessionId: "other",
          source: { rootSessionId: "other", ancestorSessionIds: [] },
        }),
      )
      .catch((error: unknown) => error);
    const healthy = other.manager.ask(input());
    manager.freezeRuntime(new Error("shared facility failed"));
    expect(await a).toMatchObject({ code: "PERMISSION_UNAVAILABLE" });
    expect(await b).toMatchObject({ code: "PERMISSION_UNAVAILABLE" });
    expect(manager.listPending()).toEqual([]);
    other.manager.respond("child", "p1", { type: "once" });
    await expect(healthy).resolves.toBe("once");
  });
  it("delivers specialized notifications after commit and terminal ownership before ordinary observers", async () => {
    const order: string[] = [];
    const { manager, bus } = harness({
      criticalCommit: (event) => {
        order.push(`commit:${event.type}`);
      },
      onCommitted: (event) => {
        order.push(`notify:${event.type}`);
        if (event.type === "resolved") {
          order.push(
            manager.respond("child", event.identity.id, { type: "once" }),
          );
          throw new Error("transport notification failed");
        }
      },
    });
    bus.subscribe(PermissionEvent.Updated, () => {
      order.push("bus:requested");
    });
    bus.subscribe(PermissionEvent.Replied, () => {
      order.push("bus:resolved");
    });
    const pending = manager.ask(input());
    manager.respond("child", "p1", { type: "once" });
    await expect(pending).resolves.toBe("once");
    expect(order).toEqual([
      "commit:requested",
      "notify:requested",
      "bus:requested",
      "commit:resolved",
      "notify:resolved",
      "already-resolved",
      "bus:resolved",
    ]);
    expect(manager.isHealthy("root")).toBe(true);
  });

  it("rejects a conflicting id before replacing the existing request", async () => {
    const { manager } = harness({ generateId: () => "same" });
    const original = manager.ask(input()).catch((error: unknown) => error);
    await expect(manager.ask(input())).rejects.toThrow(
      "PERMISSION_UNAVAILABLE",
    );
    expect(await original).toMatchObject({ code: "PERMISSION_UNAVAILABLE" });
    expect(manager.listPending()).toEqual([]);
  });
  it("removes abort listeners and completes waits if rule storage throws after ownership is claimed", async () => {
    const bus = createBus();
    const state = createPermissionState({ bus });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const manager = createPermissionManager({
      bus,
      state,
      generateId: () => "p1",
    });
    const result = manager
      .ask(input({ signal: controller.signal }))
      .catch((error: unknown) => error);
    vi.spyOn(state, "addSessionRule").mockImplementation(() => {
      throw new Error("rule storage failed");
    });
    expect(() => manager.respond("child", "p1", { type: "always" })).toThrow(
      "PERMISSION_UNAVAILABLE",
    );
    expect(await result).toMatchObject({ code: "PERMISSION_UNAVAILABLE" });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(manager.listPending()).toEqual([]);
    controller.abort();
    expect(state.getSessionRules("child")).toEqual([]);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("rechecks cancellation immediately before registering", async () => {
    const controller = new AbortController();
    const { manager, commits } = harness({
      generateId: () => {
        controller.abort();
        return "p1";
      },
    });
    await expect(
      manager.ask(input({ signal: controller.signal })),
    ).resolves.toBe("cancel");
    expect(manager.listPending()).toEqual([]);
    expect(commits).toEqual([]);
  });

  it("keeps an already authorized rule after its call aborts", async () => {
    const { manager, state, commits } = harness();
    const controller = new AbortController();
    const pending = manager.ask(input({ signal: controller.signal }));
    manager.respond("child", "p1", { type: "always" });
    controller.abort();
    await expect(pending).resolves.toBe("always");
    expect(state.getSessionRules("child")).toHaveLength(1);
    expect(commits).toHaveLength(2);
  });
});
