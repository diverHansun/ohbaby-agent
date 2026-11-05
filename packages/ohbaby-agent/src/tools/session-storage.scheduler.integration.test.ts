import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createBus } from "../bus/index.js";
import type { ToolCallResult } from "../core/tool-scheduler/types.js";
import type { TrustPathInput } from "../sandbox/types.js";
import { createToolScheduler } from "../core/tool-scheduler/index.js";
import { createHostLocalSandboxManager } from "../adapters/ui-runtime/host-local-environment.js";
import {
  createPermissionManager,
  createPermissionState,
  PermissionEvent,
  type PermissionInfo,
} from "../permission/index.js";
import { createBuiltinTools } from "./index.js";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-session-permissions-")),
  );
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function approvals(): {
  scheduler: ReturnType<typeof createToolScheduler>;
  state: ReturnType<typeof createPermissionState>;
  requests: PermissionInfo[];
  respond: (value: "always" | "once" | "reject" | "cancel") => void;
} {
  const bus = createBus();
  const state = createPermissionState({ bus });
  const manager = createPermissionManager({ bus, state });
  const requests: PermissionInfo[] = [];
  let response: "always" | "once" | "reject" | "cancel" = "always";
  bus.subscribe(PermissionEvent.Updated, ({ info }) => {
    requests.push(info);
    if (response === "cancel") manager.cancelPending(info.sessionId);
    else manager.respond(info.sessionId, info.id, { type: response });
  });
  const scheduler = createToolScheduler({
    bus,
    permissionState: state,
    permission: {
      ask: (input) =>
        manager.ask({
          ...input,
          category:
            input.category === "subagent-control"
              ? "dangerous"
              : input.category,
          source: { rootSessionId: input.sessionId, ancestorSessionIds: [] },
        }),
    },
  });
  for (const tool of createBuiltinTools()) scheduler.register(tool);
  return {
    scheduler,
    state,
    requests,
    respond: (value: typeof response): void => {
      response = value;
    },
  };
}

it("lets a child tool persist into the registered owner root and read its generated output without approval", async () => {
  const workspace = path.join(root, "workspace");
  const storage = path.join(root, "owner");
  const scratch = path.join(storage, "scratch");
  await fs.mkdir(workspace);
  await fs.mkdir(scratch, { recursive: true });
  const names = Array.from(
    { length: 180 },
    (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(200)}`,
  );
  await Promise.all(
    names.map((name) => fs.writeFile(path.join(workspace, name), "")),
  );
  const sandbox = createHostLocalSandboxManager(workspace, {
    initialTrustedRoots: () =>
      Promise.resolve<readonly TrustPathInput[]>([
        { kind: "session-storage", path: storage },
        { kind: "session-scratch", path: scratch },
      ]),
  });
  const policy = approvals();
  const environment = await sandbox.acquire("child-session");
  try {
    const listed = await policy.scheduler.execute({
      sessionId: "child-session",
      runId: "run",
      messageId: "message",
      callId: "list",
      toolName: "list",
      params: { limit: 180 },
      environment,
    });
    expect(listed.status).toBe("success");
    expect(listed.metadata?.outputFile).toMatchObject({ status: "full" });
    const file = (listed.metadata?.outputFile as { path: string }).path;
    expect(path.dirname(file)).toBe(path.join(storage, "tool-results"));
    const read = await policy.scheduler.execute({
      sessionId: "child-session",
      runId: "run",
      messageId: "message",
      callId: "read",
      toolName: "read",
      params: { file_path: file, offset: 180, limit: 1 },
      environment,
    });
    expect(read.status).toBe("success");
    expect(read.output).toContain(names[179]);
    expect(policy.requests).toEqual([]);
  } finally {
    await environment.release();
    await sandbox.dispose();
  }
});

it("read always authorizes only reads through both live roots and remembered rules after context rebuild", async () => {
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const target = path.join(outside, "note.txt");
  await fs.writeFile(target, "original");
  const sandbox = createHostLocalSandboxManager(workspace);
  const policy = approvals();
  let environment = await sandbox.acquire("session");
  let next = 0;
  const run = (
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<ToolCallResult> =>
    policy.scheduler.execute({
      sessionId: "session",
      runId: "run",
      messageId: "message",
      callId: `call_${String(next++)}`,
      toolName,
      params,
      environment,
    });
  try {
    expect((await run("read", { file_path: target })).status).toBe("success");
    for (const tool of ["write", "edit", "bash"])
      policy.state.addSessionRule("session", {
        tool,
        decision: "allow",
        scope: "session",
      });
    const count = policy.requests.length;
    expect((await run("read", { file_path: target })).status).toBe("success");
    expect(policy.requests).toHaveLength(count);
    policy.respond("reject");
    for (const rebuild of [false, true]) {
      if (rebuild) {
        await environment.release();
        await sandbox.destroyContext("session");
        environment = await sandbox.acquire("session");
      }
      expect(
        (
          await run("write", {
            file_path: target,
            content: "changed",
            expected_mtime_ms: (await fs.stat(target)).mtimeMs,
          })
        ).status,
      ).toBe("rejected");
      expect(
        (
          await run("edit", {
            file_path: target,
            old_string: "original",
            new_string: "changed",
          })
        ).status,
      ).toBe("rejected");
      expect((await run("bash", { command: `cat "${target}"` })).status).toBe(
        "rejected",
      );
      expect(policy.requests.at(-1)?.name).toBe("external_directory_shell");
      expect(await fs.readFile(target, "utf8")).toBe("original");
      expect((await run("read", { file_path: target })).status).toBe("success");
    }
  } finally {
    await environment.release();
    await sandbox.dispose();
  }
});

it.each(["home", "ohbaby", "workspace"])(
  "protects system targets before %s cwd and wider roots, including scratch symlinks",
  async (cwdKind) => {
    const home = path.join(root, "home");
    const ohbaby = path.join(home, ".ohbaby");
    const storage = path.join(ohbaby, "sessions", "session");
    const scratch = path.join(storage, "scratch");
    const workspace = path.join(root, "workspace");
    for (const directory of [
      scratch,
      workspace,
      path.join(storage, "subagents", "x"),
      path.join(storage, "tool-results"),
    ])
      await fs.mkdir(directory, { recursive: true });
    const cwd =
      cwdKind === "home" ? home : cwdKind === "ohbaby" ? ohbaby : workspace;
    const sandbox = createHostLocalSandboxManager(cwd, {
      initialTrustedRoots: () =>
        Promise.resolve<readonly TrustPathInput[]>([
          { kind: "session-storage", path: storage },
          { kind: "session-scratch", path: scratch },
        ]),
    });
    const policy = approvals();
    policy.state.addSessionRule("session", {
      tool: "external_directory",
      decision: "allow",
      scope: "session",
    });
    for (const tool of ["write", "edit", "bash"])
      policy.state.addSessionRule("session", {
        tool,
        decision: "allow",
        scope: "session",
      });
    let environment = await sandbox.acquire("session");
    let next = 0;
    const run = (
      toolName: string,
      params: Record<string, unknown>,
    ): Promise<ToolCallResult> =>
      policy.scheduler.execute({
        sessionId: "session",
        runId: "run",
        messageId: "message",
        callId: `system_${String(next++)}`,
        toolName,
        params,
        environment,
      });
    try {
      if (cwdKind === "workspace") {
        expect((await run("list", { path: home })).status).toBe("success");
        expect(policy.requests.at(-1)?.name).toBe("external_directory_read");
        policy.requests.length = 0;
      }
      await environment.trustPath({ kind: "skill-output", path: home });
      for (const relative of ["subagents/x/y.output", "tool-results/x.txt"]) {
        const target = path.join(storage, relative);
        await fs.writeFile(target, "original");
        expect((await run("read", { file_path: target })).status).toBe(
          "success",
        );
        expect(
          (
            await run("grep", {
              path: path.dirname(target),
              pattern: "original",
            })
          ).status,
        ).toBe("success");
        expect(policy.requests).toHaveLength(0);
        const linked = path.join(scratch, `link_${String(next)}`);
        await fs.symlink(target, linked);
        for (const location of [target, linked]) {
          policy.respond("reject");
          expect(
            (
              await run("write", {
                file_path: location,
                content: "changed",
                expected_mtime_ms: (await fs.stat(target)).mtimeMs,
              })
            ).status,
          ).toBe("rejected");
          expect(policy.requests.at(-1)?.name).toBe("external_directory_write");
          expect(
            (
              await run("edit", {
                file_path: location,
                old_string: "original",
                new_string: "changed",
              })
            ).status,
          ).toBe("rejected");
          expect(
            (await run("bash", { command: `cat "${location}"` })).status,
          ).toBe("rejected");
          expect(policy.requests.at(-1)?.name).toBe("external_directory_shell");
          expect(
            (await run("bash", { command: `echo changed > "${location}"` }))
              .status,
          ).toBe("rejected");
          policy.respond("cancel");
          expect(
            (
              await run("write", {
                file_path: location,
                content: "changed",
                expected_mtime_ms: (await fs.stat(target)).mtimeMs,
              })
            ).status,
          ).toBe("cancelled");
          expect(await fs.readFile(target, "utf8")).toBe("original");
        }
        policy.requests.length = 0;
      }
      policy.respond("reject");
      expect(
        (
          await run("write", {
            file_path: path.join(scratch, "a.txt"),
            content: "scratch",
          })
        ).status,
      ).toBe("success");
      expect(
        (
          await run("bash", {
            command: `echo scratch > "${path.join(scratch, "b.txt")}"`,
          })
        ).status,
      ).toBe("success");
      expect(
        (await run("write", { file_path: "project.txt", content: "project" }))
          .status,
      ).toBe("success");
      expect(await fs.readFile(path.join(cwd, "project.txt"), "utf8")).toBe(
        "project",
      );
      expect(environment.resolveCommandContext().cwd).toBe(cwd);
      expect(policy.requests).toHaveLength(0);
      await environment.release();
      await sandbox.destroyContext("session");
      environment = await sandbox.acquire("session");
      expect(
        (
          await run("read", {
            file_path: path.join(storage, "tool-results", "x.txt"),
          })
        ).status,
      ).toBe("success");
      expect(
        (
          await run("write", {
            file_path: path.join(storage, "tool-results", "after-rebuild.txt"),
            content: "blocked",
          })
        ).status,
      ).toBe("rejected");
      expect(
        (await run("read", { file_path: path.join(scratch, "a.txt") })).output,
      ).toContain("scratch");
    } finally {
      await environment.release();
      await sandbox.dispose();
    }
  },
);

it("reuses explicit write approval only for that scope and honors a later deny even with live trust", async () => {
  const workspace = path.join(root, "workspace");
  const storage = path.join(root, "sessions", "session");
  const scratch = path.join(storage, "scratch");
  const records = path.join(storage, "tool-results");
  for (const directory of [workspace, scratch, records])
    await fs.mkdir(directory, { recursive: true });
  const sandbox = createHostLocalSandboxManager(workspace, {
    initialTrustedRoots: () =>
      Promise.resolve<readonly TrustPathInput[]>([
        { kind: "session-storage", path: storage },
        { kind: "session-scratch", path: scratch },
      ]),
  });
  const environment = await sandbox.acquire("session");
  const policy = approvals();
  policy.state.addSessionRule("session", {
    tool: "write",
    decision: "allow",
    scope: "session",
  });
  const run = (callId: string, file: string): Promise<ToolCallResult> =>
    policy.scheduler.execute({
      callId,
      sessionId: "session",
      runId: "run",
      messageId: "message",
      environment,
      toolName: "write",
      params: { file_path: path.join(file, `${callId}.txt`), content: "saved" },
    });
  try {
    expect((await run("first", records)).status).toBe("success");
    const count = policy.requests.length;
    expect((await run("second", records)).status).toBe("success");
    expect(policy.requests).toHaveLength(count);
    policy.respond("reject");
    expect(
      (await run("different", path.join(storage, "subagents"))).status,
    ).toBe("rejected");
    policy.state.addSessionRule("session", {
      tool: "external_directory_write",
      pattern: `${records}/**`,
      decision: "deny",
      scope: "session",
    });
    expect((await run("denied", records)).status).toBe("rejected");
    await expect(
      fs.stat(path.join(records, "denied.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await environment.release();
    await sandbox.dispose();
  }
});

it("shares task files between root and sibling scopes while another root remains external", async () => {
  const workspace = path.join(root, "workspace");
  const storage = path.join(root, "sessions", "owner");
  const scratch = path.join(storage, "scratch");
  await fs.mkdir(workspace);
  await fs.mkdir(scratch, { recursive: true });
  const sandbox = createHostLocalSandboxManager(workspace, {
    initialTrustedRoots: (scope) =>
      Promise.resolve<readonly TrustPathInput[]>(
        scope.sessionId === "other"
          ? []
          : [
              { kind: "session-storage", path: storage },
              { kind: "session-scratch", path: scratch },
            ],
      ),
  });
  const policy = approvals();
  policy.state.addSessionRule("child", {
    tool: "write",
    decision: "allow",
    scope: "session",
  });
  const writer = await sandbox.acquire({
    sessionId: "child",
    contextScopeId: "writer",
  });
  const sibling = await sandbox.acquire({
    sessionId: "child",
    contextScopeId: "sibling",
  });
  const parent = await sandbox.acquire("owner");
  const other = await sandbox.acquire("other");
  const target = path.join(scratch, "writer-task.txt");
  let next = 0;
  try {
    expect(
      (
        await policy.scheduler.execute({
          sessionId: "child",
          runId: "run",
          messageId: "message",
          callId: "task_write",
          environment: writer,
          toolName: "write",
          params: { file_path: target, content: "shared task" },
        })
      ).status,
    ).toBe("success");
    for (const environment of [sibling, parent])
      expect(
        (
          await policy.scheduler.execute({
            sessionId: environment.sessionId,
            runId: "run",
            messageId: "message",
            callId: `read_${String(next++)}`,
            environment,
            toolName: "read",
            params: { file_path: target },
          })
        ).output,
      ).toContain("shared task");
    expect(policy.requests).toHaveLength(0);
    policy.respond("reject");
    expect(
      (
        await policy.scheduler.execute({
          sessionId: "other",
          runId: "run",
          messageId: "message",
          callId: "other_read",
          environment: other,
          toolName: "read",
          params: { file_path: target },
        })
      ).status,
    ).toBe("rejected");
  } finally {
    for (const lease of [writer, sibling, parent, other]) await lease.release();
    await sandbox.dispose();
  }
});
