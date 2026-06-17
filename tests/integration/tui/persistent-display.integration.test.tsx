import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistentUiBackendClient } from "ohbaby-agent";
import { OhbabyTerminalApp } from "ohbaby-cli";
import {
  closeDatabase,
  getDatabase,
  schema,
} from "../../../packages/ohbaby-agent/src/services/database/index.js";
import { createDatabaseRunLedger } from "../../../packages/ohbaby-agent/src/runtime/run-ledger/index.js";
import {
  createFakeLLMClient,
  createSequentialFakeLLMClient,
  promptIsReady,
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
  await mkdir(join(directory, "workspace"), { recursive: true });
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
  it("keeps a second fresh terminal blank after another terminal creates a session", async () => {
    const directory = await tempWorkspace("ohbaby-cli-two-fresh");
    const dbPath = join(directory, "agent.db");
    const workdir = join(directory, "workspace");
    const clientA = createPersistentUiBackendClient({
      dbPath,
      llmClient: createFakeLLMClient([
        { textDelta: "Terminal A response.", finishReason: "stop" },
      ]),
      workdir,
    });
    const clientB = createPersistentUiBackendClient({
      dbPath,
      llmClient: createFakeLLMClient([]),
      workdir,
    });
    const appA = render(
      <OhbabyTerminalApp
        client={clientA}
        subscribeEvents={clientA.subscribeEvents}
      />,
    );
    const appB = render(
      <OhbabyTerminalApp
        client={clientB}
        subscribeEvents={clientB.subscribeEvents}
      />,
    );

    try {
      await waitForFrame(appA, promptIsReady);
      await waitForFrame(appB, promptIsReady);
      await expect(clientA.getSnapshot()).resolves.toMatchObject({
        activeSessionId: null,
      });
      await expect(clientB.getSnapshot()).resolves.toMatchObject({
        activeSessionId: null,
      });

      appA.stdin.write("Terminal A prompt");
      appA.stdin.write("\r");
      await waitForFrame(appA, (frame) =>
        frame.includes("Terminal A response."),
      );

      const terminalBSnapshot = await clientB.getSnapshot();
      const terminalBFrame = appB.lastFrame() ?? "";

      expect(terminalBSnapshot.activeSessionId).toBeNull();
      expect(terminalBSnapshot.sessions).toHaveLength(1);
      expect(terminalBSnapshot.status).toEqual({ kind: "idle" });
      expect(terminalBFrame).not.toContain("Terminal A prompt");
      expect(terminalBFrame).not.toContain("Terminal A response.");
    } finally {
      appA.unmount();
      appB.unmount();
    }
  });

  it("renders continued sessions, messages, and run status from the initial snapshot", async () => {
    const directory = await tempWorkspace("ohbaby-cli-persistent");
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
      startupSessionMode: { type: "continue" },
      workdir,
    });
    const app = render(
      <OhbabyTerminalApp
        client={restored}
        subscribeEvents={restored.subscribeEvents}
      />,
    );

    const frame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("Remember this") &&
        nextFrame.includes("Persisted") &&
        nextFrame.includes("auto · default ·"),
    );

    expect(frame).toContain("| Remember this");
    expect(frame).not.toContain("you");
    expect(frame).not.toContain("ohbaby");
    app.unmount();
  });

  it("does not restore stale permissions and can submit after interrupted run recovery", async () => {
    const directory = await tempWorkspace("ohbaby-cli-persistent-stale");
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
      startupSessionMode: { type: "continue" },
      workdir,
    });
    const snapshot = await restored.getSnapshot();
    const staleRun = snapshot.runs.find((run) => run.id === "run_stale");

    expect(snapshot.permissions).toEqual([]);
    expect(staleRun?.status.kind).toBe("error");
    expect(
      staleRun?.status.kind === "error" ? staleRun.status.message : "",
    ).toContain("interrupted");

    const app = render(
      <OhbabyTerminalApp
        client={restored}
        subscribeEvents={restored.subscribeEvents}
      />,
    );
    await waitForFrame(
      app,
      (frame) =>
        frame.includes("Seeded") &&
        frame.includes("auto · default ·") &&
        !frame.includes("Permission:"),
    );

    app.stdin.write("next prompt");
    app.stdin.write("\r");
    const frame = await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("Recovered prompt."),
    );

    expect(promptIsReady(frame)).toBe(true);
    expect(frame).not.toContain("Permission:");
    expect(frame).toContain("auto · default ·");
    app.unmount();
  });

  it("resumes a stored session from startup intent and continues with restored context", async () => {
    const directory = await tempWorkspace("ohbaby-cli-resume");
    const dbPath = join(directory, "agent.db");
    const workdir = join(directory, "workspace");
    const setupClient = createPersistentUiBackendClient({
      dbPath,
      llmClient: createSequentialFakeLLMClient([
        [{ textDelta: "Alpha reply.", finishReason: "stop" }],
        [{ textDelta: "Beta reply.", finishReason: "stop" }],
      ]),
      workdir,
    });

    await setupClient.submitPrompt("Alpha prompt", {
      sessionId: "session_alpha",
    });
    await setupClient.submitPrompt("Beta prompt", {
      sessionId: "session_beta",
    });
    closeDatabase();

    const requests: Parameters<typeof createSequentialFakeLLMClient>[1] = [];
    const restored = createPersistentUiBackendClient({
      dbPath,
      llmClient: createSequentialFakeLLMClient(
        [[{ textDelta: "Alpha continued.", finishReason: "stop" }]],
        requests,
      ),
      startupSessionMode: { type: "resume", sessionId: "session_alpha" },
      workdir,
    });
    const app = render(
      <OhbabyTerminalApp
        client={restored}
        subscribeEvents={restored.subscribeEvents}
      />,
    );

    await waitForFrame(
      app,
      (frame) =>
        frame.includes("Alpha prompt") &&
        frame.includes("Alpha reply.") &&
        !frame.includes("Beta reply."),
    );

    app.stdin.write("Continue alpha");
    app.stdin.write("\r");
    const frame = await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("Alpha continued."),
    );
    const lastRequest = requests.at(-1);
    const serializedMessages = JSON.stringify(lastRequest?.messages ?? []);

    expect(frame).toContain("auto · default · session_alpha");
    expect(serializedMessages).toContain("Alpha prompt");
    expect(serializedMessages).toContain("Alpha reply.");
    expect(serializedMessages).toContain("Continue alpha");
    expect(serializedMessages).not.toContain("Beta prompt");
    app.unmount();
  });

  it("opens /sessions and resumes a stored session with PgDn selection", async () => {
    const directory = await tempWorkspace("ohbaby-cli-session-picker");
    const dbPath = join(directory, "agent.db");
    const workdir = join(directory, "workspace");
    let nowTick = 0;
    const now = (): Date => {
      const date = new Date(Date.UTC(2026, 4, 25, 0, 0, nowTick));
      nowTick += 1;
      return date;
    };
    const setupClient = createPersistentUiBackendClient({
      dbPath,
      llmClient: createSequentialFakeLLMClient(
        Array.from({ length: 8 }, (_, index) => [
          { textDelta: `Reply ${String(index + 1)}.`, finishReason: "stop" },
        ]),
      ),
      now,
      workdir,
    });

    for (let index = 1; index <= 8; index += 1) {
      await setupClient.submitPrompt(`Prompt ${String(index)}`, {
        sessionId: `session_${String(index)}`,
      });
    }
    closeDatabase();

    const restored = createPersistentUiBackendClient({
      dbPath,
      llmClient: createFakeLLMClient([]),
      now,
      workdir,
    });
    const app = render(
      <OhbabyTerminalApp
        client={restored}
        subscribeEvents={restored.subscribeEvents}
      />,
    );

    app.stdin.write("/sessions");
    app.stdin.write("\r");
    await waitForFrame(app, (frame) => frame.includes("showing 1-8 of 8"));

    app.stdin.write("\u001B[6~");
    await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("> Prompt 1") &&
        nextFrame.includes("showing 1-8 of 8"),
    );
    app.stdin.write("\r");
    const frame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("auto · default · session_1") &&
        nextFrame.includes("Prompt 1") &&
        nextFrame.includes("Reply 1."),
    );

    expect(frame).not.toContain("Reply 8.");
    app.unmount();
  });

  it("rejects a resumed session from another project root", async () => {
    const directory = await tempWorkspace("ohbaby-cli-session-root");
    const dbPath = join(directory, "agent.db");
    const originalWorkdir = join(directory, "workspace-a");
    const restoredWorkdir = join(directory, "workspace-b");
    await mkdir(originalWorkdir, { recursive: true });
    await mkdir(restoredWorkdir, { recursive: true });
    const setupClient = createPersistentUiBackendClient({
      dbPath,
      llmClient: createSequentialFakeLLMClient([
        [{ textDelta: "Alpha reply.", finishReason: "stop" }],
      ]),
      workdir: originalWorkdir,
    });

    await setupClient.submitPrompt("Alpha prompt", {
      sessionId: "session_alpha",
    });
    await setupClient.dispose();
    closeDatabase();

    const requests: Parameters<typeof createSequentialFakeLLMClient>[1] = [];
    const restored = createPersistentUiBackendClient({
      dbPath,
      llmClient: createSequentialFakeLLMClient(
        [[{ textDelta: "Alpha from original root.", finishReason: "stop" }]],
        requests,
      ),
      startupSessionMode: { type: "resume", sessionId: "session_alpha" },
      workdir: restoredWorkdir,
    });
    const app = render(
      <OhbabyTerminalApp
        client={restored}
        subscribeEvents={restored.subscribeEvents}
      />,
    );

    const frame = await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("Session not found: session_alpha in current project"),
    );

    expect(frame).not.toContain("Alpha prompt");
    expect(frame).not.toContain("Alpha reply.");
    expect(requests).toHaveLength(0);
    app.unmount();
  });
});
