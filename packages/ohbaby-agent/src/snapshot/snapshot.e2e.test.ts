import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config as loadDotenv } from "dotenv";
import { afterEach, describe, expect, it } from "vitest";
import type { UiEvent, UiSnapshot } from "ohbaby-sdk";
import { createPersistentUiBackendClient } from "../adapters/ui-persistent.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../services/database/index.js";
import { getModelJsonPath } from "../config/llm/loaders.js";
import { getGlobalEnvPath, getProjectEnvPath } from "../utils/project-env.js";
import { GitSnapshotEngine } from "./diff-engine.js";
import { SnapshotService } from "./service.js";
import { SnapshotStore } from "./store.js";

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];
const TARGET_FILE = "snapshot-e2e-output.txt";
const TARGET_CONTENT = "snapshot e2e modified";

interface ModelJsonShape {
  readonly apiConfig?: {
    readonly apiKeyEnv?: unknown;
  };
}

function uniquePaths(paths: readonly (string | undefined)[]): string[] {
  return Array.from(
    new Set(paths.filter((item): item is string => item !== undefined)),
  );
}

function loadE2EEnv(): void {
  for (const envPath of uniquePaths([
    process.env.SNAPSHOT_E2E_ENV_PATH,
    getProjectEnvPath(process.cwd()),
    path.resolve(process.cwd(), "..", "..", ".env"),
    getGlobalEnvPath(),
  ])) {
    if (existsSync(envPath)) {
      loadDotenv({ path: envPath, override: false });
    }
  }
}

function readApiKeyEnvName(): string | undefined {
  try {
    const modelJson = JSON.parse(
      readFileSync(getModelJsonPath(), "utf8"),
    ) as ModelJsonShape;
    return typeof modelJson.apiConfig?.apiKeyEnv === "string"
      ? modelJson.apiConfig.apiKeyEnv
      : undefined;
  } catch {
    return undefined;
  }
}

function hasUsableApiKey(envName: string | undefined): boolean {
  return envName !== undefined && (process.env[envName]?.trim() ?? "") !== "";
}

function initialSnapshot(): UiSnapshot {
  return {
    activeSessionId: null,
    permission: {
      level: "full-access",
      mode: "auto",
      sessionRules: [],
    },
    permissions: [],
    runs: [],
    sessions: [],
    status: { kind: "idle" },
  };
}

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupPaths.push(directory);
  return directory;
}

function workdirHash(workdir: string): string {
  return createHash("sha1")
    .update(path.resolve(workdir))
    .digest("hex")
    .slice(0, 16);
}

async function gitRevParse(input: {
  readonly snapshotRoot: string;
  readonly workdir: string;
  readonly ref: string;
}): Promise<string> {
  const gitdir = path.join(
    input.snapshotRoot,
    "snapshot-git",
    workdirHash(input.workdir),
  );
  const { stdout } = await execFileAsync("git", [
    "--git-dir",
    gitdir,
    "rev-parse",
    input.ref,
  ]);
  return stdout.trim();
}

loadE2EEnv();
const apiKeyEnvName = readApiKeyEnvName();
const canRunE2E = hasUsableApiKey(apiKeyEnvName);

if (!canRunE2E) {
  process.stderr.write(
    `Skipping snapshot API E2E: ${apiKeyEnvName ?? "model api key env"} is not configured.`,
  );
}

afterEach(async () => {
  closeDatabase();
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((item) => rm(item, { recursive: true, force: true })),
  );
});

const describeIfApiKey = canRunE2E ? describe : describe.skip;

describeIfApiKey("snapshot API-backed E2E", () => {
  it("captures a real agent file write and restores the checkpoint", async () => {
    const root = await tempDir("ohbaby-snapshot-e2e-");
    const workdir = path.join(root, "workspace");
    const dbPath = path.join(root, "agent.db");
    const snapshotRoot = path.join(root, "snapshot-root");
    await rm(workdir, { recursive: true, force: true });
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(workdir, { recursive: true }),
    );

    initDatabase({ dbPath });
    const service = new SnapshotService({
      diffEngine: new GitSnapshotEngine({ snapshotRoot }),
      store: new SnapshotStore({ db: getDatabase() }),
    });
    const client = createPersistentUiBackendClient({
      dbPath,
      enableSnapshots: true,
      initialSnapshot: initialSnapshot(),
      snapshotService: service,
      storageRoot: path.join(root, "storage"),
      workdir,
    });

    client.subscribeEvents((event: UiEvent) => {
      if (event.type === "permission.requested") {
        void client.respondPermission(event.request.id, {
          choiceId: "allow_once",
        });
      }
    });

    await client.submitPrompt(
      [
        "This is an automated E2E test.",
        `Use the write tool to create ${TARGET_FILE} with exactly this content:`,
        TARGET_CONTENT,
        "Do not create any other files. After the tool succeeds, reply with done.",
      ].join("\n"),
    );

    await expect(
      readFile(path.join(workdir, TARGET_FILE), "utf8"),
    ).resolves.toBe(TARGET_CONTENT);

    const sessionId = (await client.getSnapshot()).activeSessionId;
    if (sessionId === null) {
      throw new Error("expected an active session after the E2E prompt");
    }
    const checkpoints = service.listCheckpoints(sessionId);
    expect(checkpoints).toHaveLength(1);
    const checkpoint = checkpoints[0];
    expect(checkpoint.preTreeRef).toMatch(/^[0-9a-f]{40,64}$/);

    const patches = service.getPatches(checkpoint.checkpointId);
    expect(patches).toHaveLength(1);
    expect(patches[0].postTreeRef).toMatch(/^[0-9a-f]{40,64}$/);

    await expect(
      gitRevParse({
        snapshotRoot,
        workdir: checkpoint.workdir,
        ref: `refs/snapshots/${checkpoint.checkpointId}/pre`,
      }),
    ).resolves.toBe(checkpoint.preTreeRef);
    await expect(
      gitRevParse({
        snapshotRoot,
        workdir: checkpoint.workdir,
        ref: `refs/snapshots/${checkpoint.checkpointId}/post`,
      }),
    ).resolves.toBe(patches[0].postTreeRef);

    const diff = await service.diff({
      fromCheckpointId: checkpoint.checkpointId,
    });
    expect(diff.files).toEqual([
      {
        path: TARGET_FILE,
        status: "added",
      },
    ]);

    await service.restore({ checkpointId: checkpoint.checkpointId });
    await expect(
      readFile(path.join(workdir, TARGET_FILE), "utf8"),
    ).rejects.toThrow(/ENOENT/);
  }, 180_000);
});
