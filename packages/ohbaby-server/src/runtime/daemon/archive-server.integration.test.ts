import { GitSnapshotEngine } from "../../../../ohbaby-agent/src/snapshot/diff-engine.js";
import type { UiGlobalSessionPage } from "ohbaby-sdk";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanupDeletedSessionFiles,
  commitSessionWorkspaceMove,
  createWorkspaceRegistryStore,
  deleteArchivedSession,
  getGlobalSession,
  listGlobalSessions,
  planSessionWorkspaceMove,
  restoreArchivedSession,
  searchGlobalSessions,
  resolveDefaultDirectory,
} from "ohbaby-agent";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../../../ohbaby-agent/src/services/database/index.js";
import {
  createDaemonHttpServer,
  type DaemonHttpServerHandle,
  type WorkspaceBackend,
} from "./server.js";

let root: string;
let workspace: string;
let server: DaemonHttpServerHandle;
const headers = { authorization: "Bearer test-token" };
const loadWorkspace = vi.fn();
const cleanupLog = vi.fn();
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ohbaby-archive-http-")));
  vi.stubEnv("OHBABY_HOME", join(root, "home"));
  vi.stubEnv("OHBABY_STORAGE_ROOT", join(root, "storage"));
  workspace = join(root, "workspace");
  await mkdir(workspace);
  initDatabase({ dbPath: join(root, "agent.db") });
  loadWorkspace.mockReset();
  cleanupLog.mockReset();
});
afterEach(async () => {
  await server.stop();
  vi.restoreAllMocks();
  closeDatabase();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
function add(
  id: string,
  status = "archived",
  parent: string | null = null,
): void {
  getDatabase()
    .prepare(
      `INSERT INTO session (id, project_id, working_directory, workspace_directory, parent_id, title, status, created_at, updated_at, data) VALUES (?, 'global', ?, ?, ?, ?, ?, 1, 2, '{}')`,
    )
    .run(id, workspace, workspace, parent, id, status);
}
async function start(withRegistry = true): Promise<void> {
  const backend = {
    dispose: vi.fn(),
    subscribeEvents: () => vi.fn(),
    subscribePermissionEvents: () => vi.fn(),
    getSessionIndex: () => Promise.resolve([]),
    getPermissionSnapshot: () =>
      Promise.resolve({
        permissionEpoch: "test",
        rootSessionId: null,
        permissionRevision: 0,
        requests: [],
      }),
    getSnapshot: () =>
      Promise.resolve({
        activeSessionId: null,
        permissions: [],
        runs: [],
        sessions: [],
        status: { kind: "idle" },
      }),
  } as unknown as WorkspaceBackend;
  server = createDaemonHttpServer({
    authToken: "test-token",
    backend,
    port: 0,
    scopeRoot: workspace,
    createWorkspaceBackend: loadWorkspace,
    workspaceRegistry: withRegistry
      ? createWorkspaceRegistryStore()
      : undefined,
    sessionCatalog: {
      list: listGlobalSessions,
      search: searchGlobalSessions,
      get: getGlobalSession,
      planMove: planSessionWorkspaceMove,
      commitMove: commitSessionWorkspaceMove,
      restore: restoreArchivedSession,
      delete: async (id) => {
        const result = await deleteArchivedSession(id);
        await cleanupDeletedSessionFiles(result, { log: cleanupLog });
        return result;
      },
    },
  });
  await server.start();
}
it("lists archived roots including hidden workspaces, paginates, and rejects invalid status", async () => {
  add("a");
  add("b");
  add("child", "archived", "a");
  add("active", "active");
  const registry = createWorkspaceRegistryStore();
  await registry.open(workspace);
  await registry.hide(workspace);
  await start();
  const get = (suffix: string): Promise<Response> =>
    fetch(`${server.url}/v1/sessions${suffix}`, { headers });
  const first = (await (
    await get("?status=archived&limit=1")
  ).json()) as UiGlobalSessionPage;
  expect(first.sessions.map((s: { id: string }) => s.id)).toEqual(["b"]);
  const second = (await (
    await get(`?status=archived&cursor=${first.nextCursor ?? ""}`)
  ).json()) as UiGlobalSessionPage;
  expect(second.sessions.map((s: { id: string }) => s.id)).toEqual(["a"]);
  expect(
    ((await (await get("")).json()) as UiGlobalSessionPage).sessions,
  ).toEqual([]);
  const invalid = await get("?status=foo");
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({
    error: { code: "INVALID_QUERY" },
  });
  expect(loadWorkspace).not.toHaveBeenCalled();
});
it.each([true, false])(
  "restores with registry=%s without loading an instance",
  async (withRegistry) => {
    add("root");
    const registry = createWorkspaceRegistryStore();
    await registry.open(workspace);
    await registry.hide(workspace);
    await start(withRegistry);
    const response = await fetch(`${server.url}/v1/sessions/root/unarchive`, {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      session: {
        id: "root",
        status: "active",
        workspaceDirectory: workspace,
        workingDirectory: workspace,
      },
    });
    if (withRegistry) expect(registry.list()[0]?.visibility).toBe("visible");
    expect(loadWorkspace).not.toHaveBeenCalled();
  },
);
it("restores missing folders to Recents and stages the default directory", async () => {
  add("root");
  await rm(workspace, { recursive: true });
  await start();
  const response = await fetch(`${server.url}/v1/sessions/root/unarchive`, {
    method: "POST",
    headers,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    session: {
      workspaceDirectory: null,
      pendingWorkingDirectory: resolveDefaultDirectory(),
    },
  });
  expect(loadWorkspace).not.toHaveBeenCalled();
});
it("enforces auth and lifecycle errors, then deletes a tree and its result files", async () => {
  add("root");
  add("child", "active", "root");
  add("active", "active");
  await mkdir(join(root, "storage/subagent-results/child"), {
    recursive: true,
  });
  await writeFile(
    join(root, "storage/subagent-results/child/output"),
    "result",
  );
  await start();
  for (const [method, suffix] of [
    ["POST", "/unarchive"],
    ["DELETE", ""],
  ]) {
    expect(
      (await fetch(`${server.url}/v1/sessions/root${suffix}`, { method }))
        .status,
    ).toBe(401);
    for (const [id, status, code] of [
      ["active", 409, "SESSION_NOT_ARCHIVED"],
      ["child", 409, "SESSION_NOT_ROOT"],
      ["missing", 404, "SESSION_NOT_FOUND"],
    ] as const) {
      const response = await fetch(`${server.url}/v1/sessions/${id}${suffix}`, {
        method,
        headers,
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
  }
  const response = await fetch(`${server.url}/v1/sessions/root`, {
    method: "DELETE",
    headers,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    deletedSessionIds: ["root", "child"],
  });
  expect(getGlobalSession("root")).toBeNull();
  expect(getGlobalSession("active")).not.toBeNull();
  expect(loadWorkspace).not.toHaveBeenCalled();
});

it("rejects busy archived deletion and tolerates post-commit cleanup failures", async () => {
  add("root");
  const db = getDatabase();
  db.exec(
    "INSERT INTO run_ledger (run_id, session_id, trigger, status, created_at) VALUES ('busy', 'root', 'user', 'running', 1)",
  );
  await start();
  const request = (): Promise<Response> =>
    fetch(`${server.url}/v1/sessions/root`, { method: "DELETE", headers });
  const busy = await request();
  expect(busy.status).toBe(409);
  expect(await busy.json()).toMatchObject({
    error: { code: "SESSION_RUNNING" },
  });
  db.exec(
    "UPDATE run_ledger SET status = 'succeeded'; INSERT INTO snapshot_checkpoint (checkpoint_id, session_id, turn_id, workdir, created_at) VALUES ('cp', 'root', 'turn', '/gone', 1)",
  );
  vi.spyOn(GitSnapshotEngine.prototype, "dropRef").mockRejectedValue(
    new Error("injected cleanup failure"),
  );
  const deleted = await request();
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toMatchObject({ deletedSessionIds: ["root"] });
  expect(getGlobalSession("root")).toBeNull();
  expect(cleanupLog).toHaveBeenCalledOnce();
});
