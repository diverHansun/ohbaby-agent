import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../services/database/index.js";
import { createDatabaseRunLedger } from "../runtime/run-ledger/index.js";
import { createDatabaseSessionStore } from "../services/session/index.js";
import type { RunHookContext } from "../runtime/run-manager/index.js";
import type { PreflightResult, SandboxLease } from "../sandbox/index.js";
import {
  GitSnapshotEngine,
  SnapshotHookExecutionError,
  SnapshotService,
  SnapshotStore,
} from "./index.js";
import { createSnapshotHookExecutor } from "./run-hook-adapter.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

afterEach(() => {
  closeDatabase();
});

function emptyPreflight(): PreflightResult {
  return {
    commands: [],
    denylistHits: [],
    externalPaths: [],
    internalPaths: [],
    overallDanger: "readonly",
    sensitivePaths: [],
    shellKind: "bash",
  };
}

function sandboxLease(input: {
  readonly runId: string;
  readonly sessionId: string;
  readonly workdir: string;
}): SandboxLease {
  return {
    adapterId: "host-local",
    capabilities: {
      canExecCommands: true,
      isolation: "none",
      readOnly: false,
      supportsGit: false,
    },
    containsTrustedPath: () => true,
    contextId: `context_${input.sessionId}`,
    leaseId: `lease_${input.runId}`,
    preflight: () => Promise.resolve(emptyPreflight()),
    release: () => Promise.resolve(),
    resolveCommandContext: () => ({ cwd: input.workdir, kind: "host-local" }),
    resolvePath: (inputPath: string) => join(input.workdir, inputPath),
    resolvePathForExisting: (inputPath: string) =>
      Promise.resolve(join(input.workdir, inputPath)),
    resolvePathForWrite: (inputPath: string) =>
      Promise.resolve(join(input.workdir, inputPath)),
    sessionId: input.sessionId,
    trustPath: (trustedPath) =>
      Promise.resolve({ kind: trustedPath.kind, path: trustedPath.path }),
    trustedRoots: () => [{ kind: "workspace", path: input.workdir }],
    workdir: input.workdir,
  };
}

function runHookContext(input: {
  readonly runId: string;
  readonly sessionId: string;
  readonly status: RunHookContext["status"];
  readonly workdir: string;
}): RunHookContext {
  return {
    run: {
      createdAt: 1,
      disconnectMode: "continue",
      multitaskStrategy: "reject",
      permissionProfileId: "interactive",
      runId: input.runId,
      sessionId: input.sessionId,
      status: input.status ?? "pending",
      triggerSource: "user",
    },
    runId: input.runId,
    sandboxLease: sandboxLease(input),
    sessionId: input.sessionId,
    status: input.status,
    triggerSource: "user",
  };
}

describe("createSnapshotHookExecutor", () => {
  it("wraps snapshot hook failures with point context", async () => {
    const directory = await tempDir("ohbaby-snapshot-hook-failure-");
    try {
      const workdir = join(directory, "workspace");
      await mkdir(workdir);
      const service = {
        track: () => Promise.reject(new Error("git missing")),
      } as unknown as SnapshotService;
      const hookExecutor = createSnapshotHookExecutor({ service });

      await expect(
        hookExecutor.execute(
          "pre-run",
          runHookContext({
            runId: "run_1",
            sessionId: "session_1",
            status: "pending",
            workdir,
          }),
        ),
      ).rejects.toThrow(SnapshotHookExecutionError);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("tracks before a run and captures a patch after terminal status", async () => {
    const directory = await tempDir("ohbaby-snapshot-hook-");
    try {
      const workdir = join(directory, "workspace");
      await mkdir(workdir);
      await writeFile(join(workdir, "note.txt"), "before");
      initDatabase({ dbPath: join(directory, "agent.db") });
      const db = getDatabase();
      await createDatabaseSessionStore({ db }).insert({
        agentName: "build",
        childrenIds: [],
        createdAt: 1,
        id: "session_1",
        isSubagent: false,
        projectId: "project_1",
        projectRoot: workdir,
        stats: { messageCount: 0 },
        status: "active",
        title: "Snapshot session",
        updatedAt: 1,
      });
      await createDatabaseRunLedger({ db, now: () => 1 }).createPending({
        runId: "run_1",
        sessionId: "session_1",
        triggerSource: "user",
      });
      const service = new SnapshotService({
        createCheckpointId: (): string => "checkpoint_1",
        createPatchId: (): string => "patch_1",
        diffEngine: new GitSnapshotEngine({
          snapshotRoot: join(directory, "snapshots"),
        }),
        now: (): number => 1_700_000_000_000,
        store: new SnapshotStore({ db }),
      });
      const hookExecutor = createSnapshotHookExecutor({ service });

      await hookExecutor.execute(
        "pre-run",
        runHookContext({
          runId: "run_1",
          sessionId: "session_1",
          status: "pending",
          workdir,
        }),
      );
      await writeFile(join(workdir, "note.txt"), "after");
      await hookExecutor.execute(
        "post-run",
        runHookContext({
          runId: "run_1",
          sessionId: "session_1",
          status: "succeeded",
          workdir,
        }),
      );

      const checkpoints = service.listCheckpoints("session_1");
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]).toMatchObject({
        checkpointId: "checkpoint_1",
        runId: "run_1",
        turnId: "turn_run_1",
        workdir,
      });
      expect(service.getPatches("checkpoint_1")).toMatchObject([
        {
          checkpointId: "checkpoint_1",
          fileCount: 1,
          patchId: "patch_1",
        },
      ]);
    } finally {
      closeDatabase();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
