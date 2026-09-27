import {
  mkdtemp,
  readFile,
  realpath,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import { createPermissionState } from "../../permission/index.js";
import { createToolScheduler } from "../../core/tool-scheduler/index.js";
import { createReadTool } from "../../tools/read.js";
import {
  AdapterRegistry,
  HostLocalAdapter,
  SandboxManager,
  SandboxBoundaryError,
} from "../../sandbox/index.js";
import { createStorage } from "../../services/storage/index.js";
import { InMemorySubagentExecutionStore } from "./execution-store.js";
import { createSubagentResultArtifacts } from "./result-artifacts.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup(output: string, requesterScopeId = "scope") {
  const rootDir = await mkdtemp(join(tmpdir(), "improve3-artifact-"));
  directories.push(rootDir);
  const store = new InMemorySubagentExecutionStore();
  const lookup = {
    executionId: "execution",
    parentSessionId: "parent",
    requesterScopeId,
  };
  await store.accept({
    ...lookup,
    requestId: "call",
    requesterRunId: "root-run",
    rootSessionId: "parent",
    rootRunId: "root-run",
    subagentId: "child",
    mode: "background",
    prompt: "report",
    createdAt: 1,
  });
  await store.bindChild(
    lookup,
    { sessionId: "child-session", contextScopeId: "child-scope" },
    2,
  );
  await store.finish(lookup, { status: "completed", output, completedAt: 3 });
  const storage = createStorage({ rootDir });
  const artifacts = createSubagentResultArtifacts({
    store,
    storage,
    rootDir,
    sessionExists: () => Promise.resolve(true),
  });
  return { rootDir, store, storage, artifacts, lookup };
}
describe("execution result artifacts", () => {
  it.each([51199, 51200, 51201])(
    "preserves the complete UTF-8 report at %i bytes",
    async (size) => {
      const output = "中".repeat(Math.floor(size / 3)) + "a".repeat(size % 3);
      expect(Buffer.byteLength(output)).toBe(size);
      const { artifacts, lookup } = await setup(output);
      const result = await artifacts.prepare(lookup);
      if (size <= 51200) {
        expect(result.artifact).toBeUndefined();
        expect(result.body.endsWith(output)).toBe(true);
      } else {
        expect(result.body).not.toContain(output.slice(0, 30));
        if (result.artifact?.state !== "ready")
          throw new Error("Missing complete artifact");
        expect(await readFile(result.artifact.path, "utf8")).toBe(output);
      }
    },
  );
  it("does not publish a file which Read rejects for a late NUL", async () => {
    const { artifacts, lookup } = await setup("a".repeat(5000) + "\0tail");
    expect(
      (await artifacts.prepare(lookup, { forceFile: true })).artifact?.state,
    ).toBe("error");
  });
  it("authorizes the resolved read target instead of a later replacement", async () => {
    const { artifacts, lookup, rootDir } = await setup("owned result");
    const result = await artifacts.prepare(lookup, { forceFile: true });
    if (result.artifact?.state !== "ready") throw new Error("Missing artifact");
    const file = result.artifact.path;
    const outside = join(rootDir, "unregistered.txt");
    await writeFile(outside, "outside");
    await rm(file);
    await symlink(outside, file);
    const registry = new AdapterRegistry();
    registry.register(new HostLocalAdapter());
    const manager = new SandboxManager({
      adapterRegistry: registry,
      authorizeInternalRead: async (input) => {
        await rm(file);
        await writeFile(file, "owned result");
        return artifacts.authorizeRead({ ...input, operation: "read" });
      },
    });
    const workdir = join(rootDir, "workspace");
    await mkdir(workdir);
    await manager.createContext(
      { sessionId: "parent", contextScopeId: "scope" },
      { workdir },
    );
    const lease = await manager.acquire({
      sessionId: "parent",
      contextScopeId: "scope",
    });
    await expect(lease.resolvePathForExisting(file)).rejects.toBeInstanceOf(
      SandboxBoundaryError,
    );
    await manager.release(lease);
    await manager.destroyContext({
      sessionId: "parent",
      contextScopeId: "scope",
    });
  });
  it("authorizes the primary requester with an undefined context scope", async () => {
    const { artifacts, lookup } = await setup("primary report", "primary");
    const result = await artifacts.prepare(lookup, { forceFile: true });
    if (result.artifact?.state !== "ready") throw new Error("Missing artifact");
    expect(
      await artifacts.authorizeRead({
        path: result.artifact.path,
        sessionId: "parent",
        operation: "read",
      }),
    ).toBe(true);
    expect(
      await artifacts.authorizeRead({
        path: result.artifact.path,
        sessionId: "parent",
        contextScopeId: "other",
        operation: "read",
      }),
    ).toBe(false);
  });
  it("reads through the real scheduler and sandbox without granting write or directory trust", async () => {
    const { artifacts, lookup, rootDir } = await setup("exact report");
    const result = await artifacts.prepare(lookup, { forceFile: true });
    if (result.artifact?.state !== "ready") throw new Error("Missing artifact");
    const path = result.artifact.path;
    const canonicalPath = await realpath(path);
    const bus = createBus();
    const permissionState = createPermissionState({ bus });
    const registry = new AdapterRegistry();
    registry.register(new HostLocalAdapter());
    const manager = new SandboxManager({
      adapterRegistry: registry,
      authorizeInternalRead: (input) =>
        artifacts.authorizeRead({ ...input, operation: "read" }),
    });
    const workdir = join(rootDir, "workspace");
    await mkdir(workdir);
    await manager.createContext(
      { sessionId: "parent", contextScopeId: "scope" },
      { workdir },
    );
    const lease = await manager.acquire({
      sessionId: "parent",
      contextScopeId: "scope",
    });
    const scheduler = createToolScheduler({ bus, permissionState });
    scheduler.register(createReadTool());
    const request = {
      runId: "reader",
      sessionId: "parent",
      contextScopeId: "scope",
      callId: "read",
      messageId: "message",
      toolName: "read",
      params: { file_path: path },
      environment: lease,
    };
    expect(await lease.authorizeInternalRead?.(canonicalPath)).toBe(true);
    const read = await scheduler.execute(request);
    expect(read.status).toBe("success");
    expect(read.output).toContain("exact report");
    await expect(lease.resolvePathForWrite(path)).rejects.toBeInstanceOf(
      SandboxBoundaryError,
    );
    expect(lease.trustedRoots()).toHaveLength(1);
    permissionState.addSessionRule("parent", {
      tool: "external_directory",
      decision: "deny",
      scope: "session",
    });
    expect(
      (await scheduler.execute({ ...request, callId: "denied" })).status,
    ).toBe("rejected");
    await lease.release();
  });
  it("does not publish an unreadable file as a usable entry", async () => {
    const { artifacts, lookup, store } = await setup("\0" + "x".repeat(52000));
    const result = await artifacts.prepare(lookup);
    expect(result.artifact?.state).toBe("error");
    expect(result.body).toContain("unsupported by Read");
    expect((await store.get(lookup))?.output?.length).toBe(52001);
  });
  it("cannot recreate an artifact after deletion races an atomic write", async () => {
    const { storage, store, rootDir, lookup } = await setup(
      "complete".repeat(8000),
    );
    let unblock: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const artifacts = createSubagentResultArtifacts({
      store,
      rootDir,
      sessionExists: () => Promise.resolve(true),
      storage: {
        ...storage,
        writeText: async (key, text) => {
          entered();
          await gate;
          await storage.writeText(key, text);
        },
      },
    });
    const preparing = artifacts.prepare(lookup);
    await writing;
    await artifacts.deleteSession("parent");
    unblock();
    expect((await preparing).artifact?.state).toBe("deleted");
    expect(await storage.list(["subagent-results"])).toEqual([]);
    expect((await store.get(lookup))?.artifact).toEqual({
      state: "deleted",
      cleanupPending: false,
    });
  });
  it("keeps short original text inline and exports exact UTF8 above 50 KiB", async () => {
    const short = await setup("汉".repeat(17066));
    expect((await short.artifacts.prepare(short.lookup)).body).toContain(
      "汉".repeat(17066),
    );
    expect((await short.store.get(short.lookup))?.artifact.state).toBe("none");
    const text = "汉".repeat(17067);
    const long = await setup(text);
    const delivery = await long.artifacts.prepare(long.lookup);
    expect(delivery.body).not.toContain("汉");
    expect(delivery.artifact?.state).toBe("ready");
    if (delivery.artifact?.state !== "ready")
      throw new Error("Missing artifact");
    expect(await readFile(delivery.artifact.path, "utf8")).toBe(text);
    expect(delivery.artifact.sizeBytes).toBe(Buffer.byteLength(text));
  });
  it("authorizes only the registered exact readonly file in its durable requester scope", async () => {
    const { artifacts, lookup } = await setup("report");
    const result = await artifacts.prepare(lookup, { forceFile: true });
    if (result.artifact?.state !== "ready") throw new Error("Missing artifact");
    const access = {
      path: result.artifact.path,
      sessionId: "parent",
      contextScopeId: "scope",
      operation: "read" as const,
    };
    expect(await artifacts.authorizeRead(access)).toBe(true);
    expect(
      await artifacts.authorizeRead({ ...access, sessionId: "other" }),
    ).toBe(false);
    expect(
      await artifacts.authorizeRead({ ...access, contextScopeId: "other" }),
    ).toBe(false);
    expect(
      await artifacts.authorizeRead({ ...access, operation: "write" }),
    ).toBe(false);
    expect(
      await artifacts.authorizeRead({
        ...access,
        path: `${result.artifact.path}.other`,
      }),
    ).toBe(false);
  });
  it("rejects symlink substitutions and rebuilds manually removed files from DB", async () => {
    const { artifacts, lookup, rootDir } = await setup("original");
    const result = await artifacts.prepare(lookup, { forceFile: true });
    if (result.artifact?.state !== "ready") throw new Error("Missing artifact");
    const path = result.artifact.path;
    await rm(path);
    const rebuilt = await artifacts.prepare(lookup, { forceFile: true });
    expect(rebuilt.artifact?.state).toBe("ready");
    expect(await readFile(path, "utf8")).toBe("original");
    await rm(path);
    const secret = join(rootDir, "unrelated.txt");
    await writeFile(secret, "secret");
    await symlink(secret, path);
    expect(
      await artifacts.authorizeRead({
        path,
        sessionId: "parent",
        contextScopeId: "scope",
        operation: "read",
      }),
    ).toBe(false);
  });
  it("retains complete DB body and returns explicit error after bounded export failure", async () => {
    const { store, storage, rootDir, lookup } = await setup(
      "large".repeat(11000),
    );
    let writes = 0;
    const artifacts = createSubagentResultArtifacts({
      store,
      rootDir,
      sessionExists: () => Promise.resolve(true),
      storage: {
        ...storage,
        writeText: () => {
          writes++;
          return Promise.reject(new Error("disk full"));
        },
      },
    });
    const result = await artifacts.prepare(lookup);
    expect(writes).toBe(3);
    expect(result.artifact?.state).toBe("error");
    expect(result.body).toContain("disk full");
    expect(result.body).not.toContain(".output");
    expect((await store.get(lookup))?.output).toBe("large".repeat(11000));
  });
  it("durably revokes and cleans artifacts when a child session is deleted", async () => {
    const { store, artifacts, lookup, storage, rootDir } =
      await setup("retained");
    const result = await artifacts.prepare(lookup, { forceFile: true });
    if (result.artifact?.state !== "ready") throw new Error("Missing artifact");
    await artifacts.deleteSession("child-session");
    expect((await store.get(lookup))?.artifact.state).toBe("deleted");
    const restarted = createSubagentResultArtifacts({
      store,
      storage,
      rootDir,
      sessionExists: () => Promise.resolve(true),
    });
    expect(
      (await restarted.prepare(lookup, { forceFile: true })).body,
    ).toContain("deleted");
    await expect(readFile(result.artifact.path)).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });
});
