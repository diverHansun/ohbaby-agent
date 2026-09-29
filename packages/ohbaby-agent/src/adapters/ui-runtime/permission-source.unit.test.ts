import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import { createPermissionManager } from "../../permission/index.js";
import { SessionEvent } from "../../services/session/events.js";
import type { Session } from "../../services/session/types.js";
import { createPermissionSourcePort } from "./permission-source.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function session(id: string, parentId?: string): Session {
  return {
    id,
    parentId,
    projectId: "project",
    projectRoot: process.cwd(),
    title: id,
    agentName: "default",
    createdAt: 1,
    updatedAt: 1,
    status: "active",
    stats: { messageCount: 0 },
    childrenIds: [],
    isSubagent: parentId !== undefined,
  };
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup(
  records: Session[] = [
    session("child", "middle"),
    session("middle", "root"),
    session("root"),
  ],
  getSession?: (id: string) => Promise<Session | null>,
): {
  bus: ReturnType<typeof createBus>;
  manager: ReturnType<typeof createPermissionManager>;
  sessions: Map<string, Session>;
  port: ReturnType<typeof createPermissionSourcePort>;
} {
  const bus = createBus();
  const manager = createPermissionManager({ bus });
  const sessions = new Map(records.map((item) => [item.id, item]));
  const port = createPermissionSourcePort({
    manager,
    bus,
    projectRoot: process.cwd(),
    getSession:
      getSession ??
      ((id): Promise<Session | null> =>
        Promise.resolve(sessions.get(id) ?? null)),
  });
  cleanups.push(() => {
    port.dispose();
    manager.dispose();
  });
  return { bus, manager, sessions, port };
}

function input(
  sessionId = "child",
  signal = new AbortController().signal,
): Parameters<ReturnType<typeof createPermissionSourcePort>["ask"]>[0] {
  return {
    sessionId,
    signal,
    runId: "run-child",
    callId: "call",
    messageId: "message",
    toolName: "bash",
    category: "dangerous" as const,
    params: { command: "git status" },
  };
}

async function waitPending(
  manager: ReturnType<typeof createPermissionManager>,
): Promise<
  ReturnType<ReturnType<typeof createPermissionManager>["listPending"]>[number]
> {
  await expect.poll(() => manager.listPending().length).toBe(1);
  return manager.listPending()[0];
}

describe("permission source port", () => {
  it("resolves trusted ancestry without creating an approval", async () => {
    const { port, manager } = setup();
    expect(await port.resolveSource({ sessionId: "child" })).toMatchObject({
      rootSessionId: "root",
      ancestorSessionIds: ["middle", "root"],
    });
    expect(manager.listPending()).toHaveLength(0);
    expect(port.workspaceKey).toBe(
      process.platform === "win32"
        ? process.cwd().toLowerCase()
        : process.cwd(),
    );
  });

  it("resolves owners without a permission manager and honours cancellation", async () => {
    const gate = deferred<Session | null>();
    const port = createPermissionSourcePort({
      bus: createBus(),
      projectRoot: process.cwd(),
      getSession: () => gate.promise,
    });
    cleanups.push(() => {
      port.dispose();
    });
    const controller = new AbortController();
    const pending = port.resolveSource({
      sessionId: "root",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    gate.resolve(session("root"));
    await expect(
      port.resolveSource({ sessionId: "root" }),
    ).resolves.toMatchObject({ rootSessionId: "root" });
  });

  it("freezes the trusted source ancestry and preserves the real call identity", async () => {
    const { port, manager } = setup();
    const answer = port.ask(input());
    const pending = await waitPending(manager);
    expect(pending).toMatchObject({
      sessionId: "child",
      runId: "run-child",
      callId: "call",
      rootSessionId: "root",
      ancestorSessionIds: ["middle", "root"],
      sourceLabel: "child",
    });
    manager.respond("child", pending.id, { type: "once" });
    await expect(answer).resolves.toBe("once");
  });

  it.each(["child", "middle", "root"])(
    "revokes a pending request when %s is deleted",
    async (id) => {
      const { port, manager, bus } = setup();
      const answer = port.ask(input());
      await waitPending(manager);
      bus.publish(SessionEvent.Removed, { sessionId: id });
      await expect(answer).resolves.toBe("cancel");
      expect(manager.listPending()).toEqual([]);
    },
  );

  it.each([
    ["missing parent", [session("child", "missing")]],
    ["cycle", [session("child", "root"), session("root", "child")]],
    [
      "cross workspace",
      [
        session("child", "root"),
        { ...session("root"), projectRoot: path.dirname(process.cwd()) },
      ],
    ],
    ["orphan subagent", [{ ...session("child"), isSubagent: true }]],
  ])("rejects %s without registering an approval", async (_name, records) => {
    const { port, manager } = setup(records);
    await expect(port.ask(input())).rejects.toThrow(/permission source/i);
    expect(manager.listPending()).toEqual([]);
  });

  it("cancels promptly during an unresolved session read without a late orphan", async () => {
    const read = deferred<Session | null>();
    const entered = deferred<undefined>();
    const { port, manager } = setup([], async () => {
      entered.resolve(undefined);
      return read.promise;
    });
    const controller = new AbortController();
    const answer = port.ask(input("child", controller.signal));
    await entered.promise;
    controller.abort();
    await expect(answer).resolves.toBe("cancel");
    read.resolve(session("child"));
    await Promise.resolve();
    expect(manager.listPending()).toEqual([]);
  });

  it("rejects stale ancestor results deleted while their lookup was pending", async () => {
    const read = deferred<Session | null>();
    const entered = deferred<undefined>();
    const { port, manager, bus } = setup([], async (id) => {
      if (id === "child") return session("child", "root");
      entered.resolve(undefined);
      return read.promise;
    });
    const answer = Promise.resolve(port.ask(input()));
    const rejected = expect(answer).rejects.toThrow(/permission source/i);
    await entered.promise;
    bus.publish(SessionEvent.Removed, { sessionId: "root" });
    read.resolve(session("root"));
    await rejected;
    expect(manager.listPending()).toEqual([]);
  });

  it("rejects an ancestor deleted before its ID was discovered", async () => {
    const read = deferred<Session | null>();
    const entered = deferred<undefined>();
    const { port, manager, bus } = setup([], async (id) => {
      if (id === "child") {
        entered.resolve(undefined);
        return read.promise;
      }
      return session("root");
    });
    const answer = Promise.resolve(port.ask(input()));
    const rejected = expect(answer).rejects.toThrow(/permission source/i);
    await entered.promise;
    bus.publish(SessionEvent.Removed, { sessionId: "root" });
    read.resolve(session("child", "root"));
    await rejected;
    expect(manager.listPending()).toEqual([]);
  });

  it("revokes a changed parent without revoking on title or stats updates", async () => {
    const { port, manager, bus } = setup();
    const answer = port.ask(input());
    await waitPending(manager);
    bus.publish(SessionEvent.Updated, {
      session: {
        ...session("middle", "root"),
        title: "Renamed",
        stats: { messageCount: 3 },
      },
    });
    expect(manager.listPending()).toHaveLength(1);
    bus.publish(SessionEvent.Updated, { session: session("middle", "other") });
    await expect(answer).resolves.toBe("cancel");
    expect(manager.listPending()).toEqual([]);
  });

  it("checks an available subagent record and uses its display name", async () => {
    const { bus, manager } = setup();
    const port = createPermissionSourcePort({
      manager,
      bus,
      projectRoot: process.cwd(),
      getSession: (id) =>
        Promise.resolve(session(id, id === "child" ? "root" : undefined)),
      getSubagentRecord: (item) =>
        Promise.resolve(
          item.id === "child"
            ? {
                sessionId: "child",
                parentSessionId: "root",
                name: "Researcher",
              }
            : null,
        ),
    });
    cleanups.push(() => {
      port.dispose();
    });
    const answer = port.ask(input());
    const pending = await waitPending(manager);
    expect(pending.sourceLabel).toBe("Researcher");
    manager.respond("child", pending.id, { type: "once" });
    await expect(answer).resolves.toBe("once");
  });

  it("uses the invoking context scope when resolving a shared child session label", async () => {
    const { bus, manager } = setup();
    const port = createPermissionSourcePort({
      manager,
      bus,
      projectRoot: process.cwd(),
      getSession: (id) =>
        Promise.resolve(session(id, id === "child" ? "root" : undefined)),
      getSubagentRecord: (item, contextScopeId) =>
        Promise.resolve(
          item.id === "child"
            ? {
                sessionId: "child",
                parentSessionId: "root",
                name:
                  contextScopeId === "scope-second"
                    ? "Second agent"
                    : "First agent",
              }
            : null,
        ),
    });
    cleanups.push(() => {
      port.dispose();
    });
    const answer = port.ask({ ...input(), contextScopeId: "scope-second" });
    const pending = await waitPending(manager);
    expect(pending.sourceLabel).toBe("Second agent");
    manager.respond("child", pending.id, { type: "once" });
    await expect(answer).resolves.toBe("once");
  });

  it("labels unnamed shared-session instances with their own descriptions", async () => {
    const { bus, manager } = setup();
    const port = createPermissionSourcePort({
      manager,
      bus,
      projectRoot: process.cwd(),
      getSession: (id) =>
        Promise.resolve(session(id, id === "child" ? "root" : undefined)),
      getSubagentRecord: (item, contextScopeId) =>
        Promise.resolve(
          item.id === "child"
            ? {
                sessionId: "child",
                parentSessionId: "root",
                description:
                  contextScopeId === "second"
                    ? "Approve second"
                    : "Reject first",
              }
            : null,
        ),
    });
    cleanups.push(() => {
      port.dispose();
    });
    for (const [scope, label] of [
      ["first", "Reject first"],
      ["second", "Approve second"],
    ]) {
      const answer = port.ask({ ...input(), contextScopeId: scope });
      const pending = await waitPending(manager);
      expect(pending.sourceLabel).toBe(label);
      manager.respond("child", pending.id, { type: "once" });
      await expect(answer).resolves.toBe("once");
    }
  });

  it("rejects disagreement with the subagent record parent", async () => {
    const { bus, manager } = setup();
    const port = createPermissionSourcePort({
      manager,
      bus,
      projectRoot: process.cwd(),
      getSession: () => Promise.resolve(session("child", "root")),
      getSubagentRecord: () =>
        Promise.resolve({
          sessionId: "child",
          parentSessionId: "other",
        }),
    });
    cleanups.push(() => {
      port.dispose();
    });
    await expect(port.ask(input())).rejects.toThrow(/permission source/i);
    expect(manager.listPending()).toEqual([]);
  });

  it("accepts a canonical workspace reached through a symlink", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "permission-source-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const link = path.join(directory, "workspace");
    await symlink(process.cwd(), link);
    const { port, manager } = setup([
      { ...session("child"), projectRoot: link },
    ]);
    const answer = port.ask(input());
    const pending = await waitPending(manager);
    expect(pending.rootSessionId).toBe("child");
    manager.respond("child", pending.id, { type: "once" });
    await expect(answer).resolves.toBe("once");
  });

  it("rejects a changed ancestor returned by an in-flight lookup", async () => {
    const read = deferred<Session | null>();
    const entered = deferred<undefined>();
    const { port, manager, bus } = setup([], async (id) => {
      if (id === "child") return session("child", "root");
      entered.resolve(undefined);
      return read.promise;
    });
    const answer = Promise.resolve(port.ask(input()));
    const rejected = expect(answer).rejects.toThrow(/permission source/i);
    await entered.promise;
    bus.publish(SessionEvent.Updated, { session: session("root", "other") });
    read.resolve(session("root"));
    await rejected;
    expect(manager.listPending()).toEqual([]);
  });

  it("revokes existing requests if a new validation discovers a cycle", async () => {
    const { port, manager, sessions } = setup();
    const original = port.ask(input());
    await waitPending(manager);
    sessions.set("root", session("root", "child"));
    await expect(port.ask({ ...input(), callId: "second" })).rejects.toThrow(
      /cycle/i,
    );
    expect(manager.listPending()).toEqual([]);
    await expect(original).resolves.toBe("cancel");
  });

  it("does not begin lookup when the call is already cancelled", async () => {
    let reads = 0;
    const { port, manager } = setup([], () => {
      reads += 1;
      return Promise.resolve(session("child"));
    });
    const controller = new AbortController();
    controller.abort();
    await expect(port.ask(input("child", controller.signal))).resolves.toBe(
      "cancel",
    );
    expect(reads).toBe(0);
    expect(manager.listPending()).toEqual([]);
  });

  it("disposal cancels unresolved reads without disposing the shared manager", async () => {
    const entered = deferred<undefined>();
    const read = deferred<Session | null>();
    const { port, manager } = setup([], async () => {
      entered.resolve(undefined);
      return read.promise;
    });
    const answer = port.ask(input());
    await entered.promise;
    port.dispose();
    await expect(answer).resolves.toBe("cancel");
    read.resolve(session("child"));
    const other = manager.ask({
      ...input("other"),
      category: "dangerous",
      source: { rootSessionId: "other", ancestorSessionIds: [] },
    });
    const pending = await waitPending(manager);
    manager.respond("other", pending.id, { type: "once" });
    await expect(other).resolves.toBe("once");
  });
});
