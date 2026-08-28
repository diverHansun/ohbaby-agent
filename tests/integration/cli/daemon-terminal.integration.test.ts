import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRPC,
  type CoreAPI,
  type UiEvent,
} from "../../../packages/ohbaby-sdk/src/index.js";
import {
  createRemoteCoreApiHost,
  startDaemonServer,
} from "../../../packages/ohbaby-server/src/index.js";
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

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error("Timed out waiting for daemon terminal condition");
}

function createTerminalClient(
  host: ReturnType<typeof createRemoteCoreApiHost>,
): CoreAPI & typeof host.callbacks {
  const rpc = createRPC<CoreAPI>();
  rpc.connectImpl(host.core);
  return rpc.createProxy(host.callbacks);
}

describe("explicit daemon remote terminal composition", () => {
  it("starts fresh by default and resumes history only on explicit continue", async () => {
    const home = await tempDirectory("ohbaby-daemon-terminal-");
    const authToken = "token_1";
    const daemon = await startDaemonServer({
      authToken,
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
      const firstHost = createRemoteCoreApiHost({
        authToken,
        clientId: "terminal_a",
        directory: home,
        host: daemon.host,
        port: daemon.port,
      });
      const firstClient = createTerminalClient(firstHost);
      const unsubscribe = firstClient.subscribeEvents((event) => {
        events.push(event);
      });

      try {
        const initialSnapshot = await firstClient.getSnapshot();
        expect(initialSnapshot.activeSessionId).toBeNull();
        await delay(25);
        await firstClient.submitPromptAndWait("hello daemon");
        await waitUntil(() => JSON.stringify(events).includes("daemon reply"));
      } finally {
        unsubscribe();
        await firstHost.dispose();
      }

      const eventTypes = events.map((event) => event.type);
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          "session.updated",
          "message.appended",
          "run.updated",
        ]),
      );

      const secondHost = createRemoteCoreApiHost({
        authToken,
        clientId: "terminal_b",
        directory: home,
        host: daemon.host,
        port: daemon.port,
      });
      const secondClient = createTerminalClient(secondHost);
      try {
        const snapshot = await secondClient.getSnapshot();
        const serializedSnapshot = JSON.stringify(snapshot);

        expect(snapshot.activeSessionId).toBeNull();
        expect(snapshot.sessions).toHaveLength(1);
        expect(snapshot.sessions[0]?.messages).toEqual([]);
        expect(serializedSnapshot).not.toContain("daemon reply");
      } finally {
        await secondHost.dispose();
      }

      const continuedHost = createRemoteCoreApiHost({
        authToken,
        clientId: "terminal_c",
        directory: home,
        host: daemon.host,
        port: daemon.port,
        startupIntent: { startupSessionMode: { type: "continue" } },
      });
      const continuedClient = createTerminalClient(continuedHost);
      try {
        const snapshot = await continuedClient.getSnapshot();
        const serializedSnapshot = JSON.stringify(snapshot);

        expect(snapshot.sessions).toHaveLength(1);
        expect(serializedSnapshot).toContain("hello daemon");
        expect(serializedSnapshot).toContain("daemon reply");
      } finally {
        await continuedHost.dispose();
      }
    } finally {
      await daemon.stop();
    }
  }, 30_000);
});
