import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import type { ToolCallResult } from "../../core/tool-scheduler/types.js";
import { createToolScheduler } from "../../core/tool-scheduler/index.js";
import { createHostLocalSandboxManager } from "../../adapters/ui-runtime/host-local-environment.js";
import { createUiRuntimeComposition } from "../../adapters/ui-runtime/composition.js";
import {
  createMessageManager,
  createInMemoryMessageStore,
} from "../../core/message/index.js";
import {
  createPermissionManager,
  createPermissionState,
  PermissionEvent,
  type PermissionInfo,
} from "../../permission/index.js";
import {
  ensureSessionStorage,
  resolveSessionStorageRoot,
} from "../../paths/session-storage.js";
import { createStorage } from "../../services/storage/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import { SessionEvent } from "../../services/session/index.js";
import { createBuiltinTools } from "../../tools/index.js";
import type { SandboxLease, TrustPathInput } from "../../sandbox/types.js";
import {
  type ExecutionLookup,
  DatabaseSubagentExecutionStore,
} from "./execution-store.js";
import { createSubagentResultArtifacts } from "./result-artifacts.js";

let home: string;
beforeEach(async () => {
  home = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-result-permissions-")),
  );
  vi.stubEnv("OHBABY_HOME", home);
  initDatabase({ dbPath: path.join(home, "agent.db") });
});
afterEach(async () => {
  closeDatabase();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

async function report(): Promise<{
  store: DatabaseSubagentExecutionStore;
  lookup: ExecutionLookup;
  file: string;
  output: string;
}> {
  const store = new DatabaseSubagentExecutionStore({ db: getDatabase() });
  const lookup = {
    executionId: "execution",
    parentSessionId: "owner",
    requesterScopeId: "primary",
  };
  const output = "exact report\n" + "report line\n".repeat(5000);
  await store.accept({
    ...lookup,
    requestId: "call",
    requesterRunId: "run",
    rootSessionId: "owner",
    rootRunId: "run",
    subagentId: "writer",
    mode: "background",
    prompt: "report",
    createdAt: 1,
  });
  await store.finish(lookup, { status: "completed", output, completedAt: 2 });
  const rootDir = resolveSessionStorageRoot();
  const artifacts = createSubagentResultArtifacts({
    store,
    rootDir,
    storage: createStorage({ rootDir }),
    sessionExists: () => Promise.resolve(true),
  });
  const prepared = await artifacts.prepare(lookup);
  if (prepared.artifact?.state !== "ready") throw new Error("Missing report");
  expect(prepared.artifact.path).toBe(
    path.join(
      home,
      "sessions",
      "owner",
      "subagents",
      "writer",
      "execution.output",
    ),
  );
  expect(await fs.readFile(prepared.artifact.path, "utf8")).toBe(output);
  return { store, lookup, file: prepared.artifact.path, output };
}

type ApprovalResponse = "once" | "reject" | "cancel" | undefined;

function approvals(): {
  state: ReturnType<typeof createPermissionState>;
  manager: ReturnType<typeof createPermissionManager>;
  requests: PermissionInfo[];
  respond(value: ApprovalResponse): void;
  run(
    environment: SandboxLease,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<ToolCallResult>;
} {
  const bus = createBus();
  const state = createPermissionState({ bus, initialLevel: "default" });
  const manager = createPermissionManager({ bus, state });
  const requests: PermissionInfo[] = [];
  let response: ApprovalResponse = "reject";
  bus.subscribe(PermissionEvent.Updated, ({ info }) => {
    requests.push(info);
    if (response === "cancel") manager.cancelPending(info.sessionId);
    else if (response)
      manager.respond(info.sessionId, info.id, { type: response });
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
  let next = 0;
  return {
    state,
    manager,
    requests,
    respond(value: ApprovalResponse): void {
      response = value;
    },
    run(
      environment: SandboxLease,
      toolName: string,
      params: Record<string, unknown>,
    ): Promise<ToolCallResult> {
      return scheduler.execute({
        sessionId: environment.sessionId,
        contextScopeId: environment.contextScopeId,
        runId: "run",
        messageId: "message",
        callId: `call_${String(next++)}`,
        environment,
        toolName,
        params,
      });
    },
  };
}

it("shares an exported SQLite report with root and sibling readers while system edits and Bash require approval", async () => {
  const { file, output } = await report();
  const workspace = path.join(home, "workspace");
  await fs.mkdir(workspace);
  const sandbox = createHostLocalSandboxManager(workspace, {
    initialTrustedRoots: async (scope) => {
      if (scope.sessionId === "other") return [];
      const directory = await ensureSessionStorage("owner");
      return [
        { kind: "session-storage", path: directory },
        { kind: "session-scratch", path: path.join(directory, "scratch") },
      ];
    },
  });
  const policy = approvals();
  const parent = await sandbox.acquire("owner");
  const sibling = await sandbox.acquire({
    sessionId: "sibling-session",
    contextScopeId: "sibling",
  });
  const other = await sandbox.acquire("other");
  try {
    for (const environment of [parent, sibling]) {
      expect(
        (await policy.run(environment, "read", { file_path: file })).output,
      ).toContain("exact report");
      expect(
        (
          await policy.run(environment, "grep", {
            path: path.dirname(file),
            pattern: "exact report",
          })
        ).status,
      ).toBe("success");
    }
    expect(policy.requests).toHaveLength(0);
    for (const environment of [parent, sibling]) {
      // Reading wider directories or granting ordinary tool approval cannot grant system writes.
      await environment.trustPath({
        kind: "external-read-approved",
        path: home,
      });
      await environment.trustPath({ kind: "skill-output", path: home });
      for (const tool of ["write", "edit", "bash"])
        policy.state.addSessionRule(environment.sessionId, {
          tool,
          decision: "allow",
          scope: "session",
        });
      for (const response of ["reject", "cancel"] as const) {
        policy.respond(response);
        const status = response === "reject" ? "rejected" : "cancelled";
        expect(
          (
            await policy.run(environment, "write", {
              file_path: file,
              content: "changed",
              expected_mtime_ms: (await fs.stat(file)).mtimeMs,
            })
          ).status,
        ).toBe(status);
        expect(policy.requests.at(-1)?.name).toBe("external_directory_write");
        expect(
          (
            await policy.run(environment, "edit", {
              file_path: file,
              old_string: "exact report",
              new_string: "changed",
            })
          ).status,
        ).toBe(status);
        for (const command of [`cat "${file}"`, `echo changed > "${file}"`]) {
          expect(
            (await policy.run(environment, "bash", { command })).status,
          ).toBe(status);
          expect(policy.requests.at(-1)?.name).toBe("external_directory_shell");
        }
        expect(await fs.readFile(file, "utf8")).toBe(output);
      }
    }
    policy.respond(undefined);
    const pending = policy.run(parent, "write", {
      file_path: file,
      content: "approved report",
      expected_mtime_ms: (await fs.stat(file)).mtimeMs,
    });
    const previousCount = policy.requests.length;
    await vi.waitFor(() => {
      expect(policy.requests.length).toBe(previousCount + 1);
    });
    expect(await fs.readFile(file, "utf8")).toBe(output);
    const request = policy.requests.at(-1);
    if (!request) throw new Error("Missing write approval");
    policy.manager.respond(request.sessionId, request.id, { type: "once" });
    expect((await pending).status).toBe("success");
    expect(await fs.readFile(file, "utf8")).toBe("approved report");
    policy.respond("once");
    expect(
      (
        await policy.run(parent, "edit", {
          file_path: file,
          old_string: "approved report",
          new_string: "approved edit",
        })
      ).status,
    ).toBe("success");
    expect(await fs.readFile(file, "utf8")).toBe("approved edit");
    policy.respond("reject");
    expect((await policy.run(other, "read", { file_path: file })).status).toBe(
      "rejected",
    );
    expect(policy.requests.at(-1)?.name).toBe("external_directory_read");
    const external = path.join(home, "external.txt");
    await fs.writeFile(external, "external");
    expect(
      (await policy.run(other, "read", { file_path: external })).status,
    ).toBe("rejected");
  } finally {
    for (const environment of [parent, sibling, other])
      await environment.release();
    await sandbox.dispose();
  }
});

it("keeps a successful export behind external read approval when no session roots were registered", async () => {
  const { file, output } = await report();
  const workspace = path.join(home, "workspace");
  await fs.mkdir(workspace);
  const sandbox = createHostLocalSandboxManager(workspace, {
    initialTrustedRoots: () => Promise.resolve<readonly TrustPathInput[]>([]),
  });
  const environment = await sandbox.acquire("owner");
  const policy = approvals();
  try {
    expect(
      (await policy.run(environment, "read", { file_path: file })).status,
    ).toBe("rejected");
    expect(policy.requests.at(-1)?.name).toBe("external_directory_read");
    expect(await fs.readFile(file, "utf8")).toBe(output);
    policy.respond("once");
    expect(
      (await policy.run(environment, "read", { file_path: file })).output,
    ).toContain("exact report");
  } finally {
    await environment.release();
    await sandbox.dispose();
  }
});

it("revokes and removes the relocated report through the composition SessionEvent.Removed handler", async () => {
  const { file, store, lookup } = await report();
  const bus = createBus();
  const workdir = path.join(home, "workspace");
  await fs.mkdir(workdir);
  const composition = await createUiRuntimeComposition({
    bus,
    workdir,
    resolveRunModel: () =>
      Promise.reject(new Error("No model request expected")),
    messageManager: createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    }),
    permissionState: createPermissionState({ bus }),
    goalExecutionControl: { interruptGoalExecution: () => Promise.resolve() },
    subagentExecutionStore: store,
    mcpManager: { getAllTools: () => Promise.resolve([]) },
  });
  try {
    bus.publish(SessionEvent.Removed, { sessionId: "owner" });
    await vi.waitFor(async () => {
      expect((await store.get(lookup))?.artifact).toEqual({
        state: "deleted",
        cleanupPending: false,
      });
    });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await composition.dispose();
  }
});
