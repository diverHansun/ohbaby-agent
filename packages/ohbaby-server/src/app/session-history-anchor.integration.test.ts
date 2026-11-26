import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { UiSessionHistory } from "ohbaby-sdk";
import { createPersistentUiBackendClient } from "../../../ohbaby-agent/src/adapters/ui-persistent.js";
import { createBus } from "../../../ohbaby-agent/src/bus/index.js";
import {
  createMessageManager,
  createDatabaseMessageStore,
} from "../../../ohbaby-agent/src/core/message/index.js";
import {
  closeDatabase,
  initDatabase,
} from "../../../ohbaby-agent/src/services/database/index.js";
import { searchGlobalSessions } from "../../../ohbaby-agent/src/services/session/global-query.js";
import { createDatabaseSessionStore } from "../../../ohbaby-agent/src/services/session/database-store.js";
import { createDaemonHttpServer } from "../runtime/daemon/server.js";

it("reads a stable anchored window and its previous page over the bound daemon routes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-history-anchor-"));
  const dbPath = join(directory, "agent.db");
  initDatabase({ dbPath });
  const sessionId = "root";
  const ids = Array.from(
    { length: 120 },
    (_, i) => "m" + String(i).padStart(3, "0"),
  );
  const sessions = createDatabaseSessionStore();
  for (const id of [sessionId, "other"])
    await sessions.insert({
      id,
      projectId: "p",
      workingDirectory: directory,
      agentName: "build",
      title: id,
      status: "active",
      createdAt: 1000,
      updatedAt: 2000,
      stats: { messageCount: 0 },
      childrenIds: [],
      isSubagent: false,
    });
  const store = createDatabaseMessageStore();
  const manager = createMessageManager({
    bus: createBus(),
    store,
    now: () => 3000,
  });
  // All timestamps tie. The two attempts are more than a page apart.
  for (const [index, id] of ids.entries()) {
    const retry = index === 6 || index === 99;
    await manager.createMessage(
      retry
        ? {
            id,
            sessionId,
            agent: "build",
            role: "assistant",
            runId: "run",
            modelRequests: [
              {
                messageId: id,
                requestId: id,
                runId: "run",
                step: 1,
                attempt: index === 6 ? 1 : 2,
                startedAt: index,
                purpose: "agent-step",
                ...(index === 6
                  ? { outcome: "error", retryScheduled: true }
                  : { outcome: "running" }),
              },
            ],
          }
        : { id, sessionId, agent: "build", role: "user" },
    );
    await manager.appendPart(id, { type: "text", text: id });
  }
  for (const [id, owner, scope] of [
    ["foreign", "other", undefined],
    ["child", sessionId, "child-scope"],
  ] as const) {
    await manager.createMessage({
      id,
      sessionId: owner,
      contextScopeId: scope,
      agent: "build",
      role: "user",
    });
    await manager.appendPart(id, { type: "text", text: id });
  }
  const backend = createPersistentUiBackendClient({
    dbPath,
    workdir: directory,
    startupSessionMode: { type: "fresh" },
  });
  const server = createDaemonHttpServer({
    authToken: "test",
    host: "127.0.0.1",
    port: 0,
    backend,
  });
  try {
    await server.start();
    const headers = {
      authorization: "Bearer test",
      "x-ohbaby-client-id": "test",
      "content-type": "application/json",
    };
    const request = (path: string, init?: RequestInit): Promise<Response> =>
      fetch(`http://127.0.0.1:${String(server.port)}${path}`, {
        ...init,
        headers,
      });
    const registered = await request("/v1/clients", {
      method: "POST",
      body: JSON.stringify({
        clientId: "test",
        startupIntent: { resumeSessionId: sessionId },
      }),
    });
    expect(registered.status).toBe(200);
    const binding = (await registered.json()) as {
      runtimeEpoch: string;
      bindingGeneration: number;
      rootSessionId: string;
    };
    expect(binding.rootSessionId).toBe(sessionId);
    const scope = new URLSearchParams({
      runtimeEpoch: binding.runtimeEpoch,
      bindingGeneration: String(binding.bindingGeneration),
    });
    const url = `/v1/sessions/root/history?${scope.toString()}&`;
    const read = async (params: string): Promise<UiSessionHistory> => {
      const response = await request(url + params);
      expect(response.status).toBe(200);
      return ((await response.json()) as { history: UiSessionHistory }).history;
    };
    const messageIds = (page: UiSessionHistory): string[] =>
      page.messages.map((m) => m.id);
    const latest = await read("");
    expect(messageIds(latest)).toEqual(ids.slice(-50));
    expect(messageIds(await read("anchorMessageId=m060&limit=50"))).toEqual(
      ids.slice(36, 86),
    );
    const anchored = await read("anchorMessageId=m008&limit=1");
    expect(anchored.version).toEqual(latest.version);
    expect(messageIds(anchored)).toEqual(ids.slice(7, 10));
    expect(anchored.hasMore).toBe(true);
    if (!anchored.before) throw new Error("Missing earlier page cursor");
    expect(messageIds(await read("limit=3&before=" + anchored.before))).toEqual(
      ids.slice(4, 7),
    );
    expect(messageIds(await read("anchorMessageId=m000&limit=3"))).toEqual(
      ids.slice(0, 2),
    );
    expect(messageIds(await read("anchorMessageId=m119&limit=3"))).toEqual(
      ids.slice(-2),
    );
    const rpc = await request("/api/rpc", {
      method: "POST",
      body: JSON.stringify({
        id: "anchor",
        clientId: "test",
        method: "getSessionHistory",
        params: [
          {
            sessionId,
            runtimeEpoch: binding.runtimeEpoch,
            bindingGeneration: binding.bindingGeneration,
            anchorMessageId: "m008",
            limit: 1,
          },
        ],
      }),
    });
    expect(
      ((await rpc.json()) as { result: UiSessionHistory }).result.messages,
    ).toEqual(anchored.messages);
    const invalid = await request(url + "before=cursor&anchorMessageId=m008");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "INVALID_SESSION_QUERY" },
    });
    expect(searchGlobalSessions({ query: "m119" }).hits).toMatchObject([
      { messageId: "m119" },
    ]);
    await store.markRewound(sessionId, "m119", new Date(4000).toISOString());
    for (const target of ["missing", "foreign", "child", "m006", "m119"]) {
      expect(await read(`anchorMessageId=${target}&limit=3`)).toMatchObject({
        version: latest.version,
        messages: [],
        runs: [],
        prompts: [],
        hasMore: false,
      });
    }
  } finally {
    await server.stop();
    await backend.dispose();
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});
