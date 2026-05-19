import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistentUiBackendClient } from "ohbaby-agent";
import { OhbabyTerminalApp } from "ohbaby-tui";
import {
  closeDatabase,
  getDatabase,
  schema,
} from "../../../packages/ohbaby-agent/src/services/database/index.js";
import { createDatabaseRunLedger } from "../../../packages/ohbaby-agent/src/runtime/run-ledger/index.js";
import {
  createFakeLLMClient,
  promptLine,
  waitForFrame,
} from "./helpers.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  closeDatabase();
  for (const directory of cleanupDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function tempWorkspace(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), `.tmp-${prefix}-`));
  cleanupDirectories.push(directory);
  return directory;
}

function markBackendLeaseDead(): void {
  getDatabase()
    .prepare(
      `UPDATE ${schema.appState.tableName}
       SET value = ?, updated_at = ?
       WHERE scope = ? AND key = ?`,
    )
    .run(
      JSON.stringify({
        ownerId: "dead_backend",
        pid: -1,
        updatedAt: 42_000,
      }),
      42_000,
      "global",
      "persistentUiBackendLease",
    );
}

describe("TUI persistent backend display", () => {
  it("renders restored sessions, messages, and run status from the initial snapshot", async () => {
    const directory = await tempWorkspace("ohbaby-tui-persistent");
    const dbPath = join(directory, "agent.db");
    const workdir = join(directory, "workspace");

    const client = createPersistentUiBackendClient({
      dbPath,
      llmClient: createFakeLLMClient([
        { textDelta: "Persisted", finishReason: "stop" },
      ]),
      workdir,
    });
    await client.submitPrompt("Remember this");
    closeDatabase();

    const restored = createPersistentUiBackendClient({
      dbPath,
      llmClient: createFakeLLMClient([]),
      workdir,
    });
    const app = render(<OhbabyTerminalApp client={restored} />);

    const frame = await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("Remember this") &&
      nextFrame.includes("Persisted") &&
      nextFrame.includes("status: idle | session:"),
    );

    expect(frame).toContain("you");
    expect(frame).toContain("assistant");
    app.unmount();
  });

  it("does not restore stale permissions and can submit after interrupted run recovery", async () => {
    const directory = await tempWorkspace("ohbaby-tui-persistent-stale");
    const dbPath = join(directory, "agent.db");
    const workdir = join(directory, "workspace");

    const client = createPersistentUiBackendClient({
      dbPath,
      llmClient: createFakeLLMClient([
        { textDelta: "Seeded", finishReason: "stop" },
      ]),
      workdir,
    });
    await client.submitPrompt("Seed session");
    const seededSnapshot = await client.getSnapshot();
    const sessionId = seededSnapshot.activeSessionId;
    if (!sessionId) {
      throw new Error("expected active session");
    }

    const runLedger = createDatabaseRunLedger({ now: () => 42_000 });
    await runLedger.createPending({
      runId: "run_stale",
      sessionId,
      triggerSource: "user",
    });
    await runLedger.markRunning("run_stale");
    markBackendLeaseDead();

    const restored = createPersistentUiBackendClient({
      dbPath,
      llmClient: createFakeLLMClient([
        { textDelta: "Recovered prompt.", finishReason: "stop" },
      ]),
      workdir,
    });
    const snapshot = await restored.getSnapshot();
    const staleRun = snapshot.runs.find((run) => run.id === "run_stale");

    expect(snapshot.permissions).toEqual([]);
    expect(staleRun?.status.kind).toBe("error");
    expect(
      staleRun?.status.kind === "error" ? staleRun.status.message : "",
    ).toContain("interrupted");

    const app = render(<OhbabyTerminalApp client={restored} />);
    await waitForFrame(app, (frame) =>
      frame.includes("Seeded") &&
      frame.includes("status: idle | session:") &&
      !frame.includes("Permission:"),
    );

    app.stdin.write("next prompt");
    app.stdin.write("\r");
    const frame = await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("Recovered prompt."),
    );

    expect(promptLine(frame).trimEnd()).toBe(">");
    expect(frame).not.toContain("Permission:");
    expect(frame).toContain("status: idle | session:");
    app.unmount();
  });
});
