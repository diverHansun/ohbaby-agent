import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";

interface ClaimResult {
  readonly errorName?: string;
  readonly ok: boolean;
  readonly ownerId: string;
  readonly runId?: string;
}

const children: ChildProcessWithoutNullStreams[] = [];
const cleanupDirectories: string[] = [];

afterEach(async () => {
  closeDatabase();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child).catch(() => undefined);
    }
  }
  await Promise.all(
    cleanupDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function spawnClaim(input: {
  readonly dbPath: string;
  readonly hold: boolean;
  readonly ownerId: string;
  readonly runId: string;
}): ChildProcessWithoutNullStreams {
  const databaseUrl = pathToFileURL(
    resolve("packages/ohbaby-agent/src/services/database/index.ts"),
  ).href;
  const ledgerUrl = pathToFileURL(
    resolve("packages/ohbaby-agent/src/runtime/run-ledger/index.ts"),
  ).href;
  const script = `
    const { closeDatabase, initDatabase } = await import(${JSON.stringify(databaseUrl)});
    const { createDatabaseRunLedger } = await import(${JSON.stringify(ledgerUrl)});
    const input = JSON.parse(process.env.OHBABY_TEST_INPUT);
    initDatabase({ dbPath: input.dbPath });
    try {
      const ledger = createDatabaseRunLedger({ ownerId: input.ownerId, ownerPid: process.pid });
      const record = await ledger.claimPendingRun({ runId: input.runId, sessionId: "session_shared", triggerSource: "user" });
      process.stdout.write("OHBABY_CLAIM " + JSON.stringify({ ok: true, ownerId: input.ownerId, runId: record.runId }) + "\\n");
      if (input.hold) {
        await new Promise((resolveStop) => {
          const keepAlive = setInterval(() => undefined, 1_000);
          process.once("SIGTERM", () => {
            clearInterval(keepAlive);
            resolveStop();
          });
        });
      }
    } catch (error) {
      process.stdout.write("OHBABY_CLAIM " + JSON.stringify({ ok: false, ownerId: input.ownerId, errorName: error?.name }) + "\\n");
    } finally {
      closeDatabase();
    }
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--eval", script], {
    env: { ...process.env, OHBABY_TEST_INPUT: JSON.stringify(input) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function waitForClaim(
  child: ChildProcessWithoutNullStreams,
): Promise<ClaimResult> {
  return new Promise((resolveClaim, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for claim: ${stderr}`));
    }, 10_000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const line = stdout
        .split("\n")
        .find((candidate) => candidate.startsWith("OHBABY_CLAIM "));
      if (!line) {
        return;
      }
      clearTimeout(timeout);
      resolveClaim(
        JSON.parse(line.slice("OHBABY_CLAIM ".length)) as ClaimResult,
      );
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!stdout.includes("OHBABY_CLAIM ")) {
        clearTimeout(timeout);
        reject(
          new Error(`Claim process exited with ${String(code)}: ${stderr}`),
        );
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for claim process to exit"));
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

describe("TUI and serve dual-writer run claim", () => {
  it("allows only one real process to own an active run for a session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohbaby-dual-writer-"));
    cleanupDirectories.push(directory);
    const dbPath = join(directory, "agent.db");
    initDatabase({ dbPath });
    getDatabase()
      .prepare(
        `INSERT INTO session
          (id, project_id, project_root, agent, parent_id, title, status, created_at, updated_at, message_count, last_message_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "session_shared",
        "project_shared",
        directory,
        "default",
        null,
        "Shared session",
        "active",
        1,
        1,
        0,
        null,
        "{}",
      );
    closeDatabase();

    const tui = spawnClaim({
      dbPath,
      hold: true,
      ownerId: "tui-process",
      runId: "run_tui",
    });
    await expect(waitForClaim(tui)).resolves.toEqual({
      ok: true,
      ownerId: "tui-process",
      runId: "run_tui",
    });

    const serve = spawnClaim({
      dbPath,
      hold: false,
      ownerId: "serve-process",
      runId: "run_serve",
    });
    await expect(waitForClaim(serve)).resolves.toEqual({
      errorName: "SessionRunBusyError",
      ok: false,
      ownerId: "serve-process",
    });
    await waitForExit(serve);

    initDatabase({ dbPath });
    const active = getDatabase()
      .prepare<{ readonly count: number }>(
        `SELECT COUNT(*) AS count FROM run_ledger
         WHERE session_id = ? AND status IN ('pending', 'running')`,
      )
      .get("session_shared");
    expect(active?.count).toBe(1);
    closeDatabase();

    tui.kill("SIGTERM");
    await waitForExit(tui);
  }, 20_000);
});
