import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UiEvent } from "../../../packages/ohbaby-sdk/src/index.js";
import {
  createRemoteUiBackendClient,
  startDaemonServer,
} from "../../../packages/ohbaby-agent/src/runtime/daemon/index.js";
import { createFakeLLMClient } from "../tui/helpers.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirectories.push(directory);
  return directory;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("explicit daemon remote terminal flow", () => {
  it("submits through one remote client and resumes history through another", async () => {
    const home = await tempDirectory("ohbaby-daemon-terminal-");
    const daemon = await startDaemonServer({
      dbPath: join(home, "agent.db"),
      host: "127.0.0.1",
      llmClient: createFakeLLMClient([
        {
          finishReason: "stop",
          textDelta: "daemon reply",
        },
      ]),
      pidFilePath: join(home, "daemon.pid"),
      port: 0,
      stateFilePath: join(home, "daemon-state.json"),
      workdir: home,
    });

    try {
      const events: UiEvent[] = [];
      const firstClient = createRemoteUiBackendClient({
        clientId: "terminal_a",
        host: daemon.host,
        port: daemon.port,
      });
      const unsubscribe = firstClient.subscribeEvents((event) => {
        events.push(event);
      });

      try {
        await delay(25);
        await firstClient.submitPrompt("hello daemon");
      } finally {
        unsubscribe();
        await firstClient.dispose();
      }

      const eventTypes = events.map((event) => event.type);
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          "session.updated",
          "message.appended",
          "run.updated",
        ]),
      );

      const secondClient = createRemoteUiBackendClient({
        clientId: "terminal_b",
        host: daemon.host,
        port: daemon.port,
      });
      try {
        const snapshot = await secondClient.getSnapshot();
        const serializedSnapshot = JSON.stringify(snapshot);

        expect(snapshot.sessions).toHaveLength(1);
        expect(serializedSnapshot).toContain("hello daemon");
        expect(serializedSnapshot).toContain("daemon reply");
      } finally {
        await secondClient.dispose();
      }
    } finally {
      await daemon.stop();
    }
  }, 30_000);
});
