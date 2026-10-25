import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPersistentUiBackendClient } from "ohbaby-agent";
import { createBus } from "../../../ohbaby-agent/src/bus/index.js";
import {
  createMessageManager,
  createDatabaseMessageStore,
} from "../../../ohbaby-agent/src/core/message/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../../../ohbaby-agent/src/services/database/index.js";
import { createDatabaseSessionStore } from "../../../ohbaby-agent/src/services/session/database-store.js";
import { createDaemonServerApp } from "./create-app.js";
import { listenToNodeServer } from "../transport/node-listen.js";

// This fixture protects the transport's ability to query a real archived session
// without binding the client to it or changing durable conversation state.
describe("persistent session export over HTTP", () => {
  it("returns identical REST and JSONRPC exports for unselected archived history without writes or events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohbaby-export-http-"));
    const dbPath = join(directory, "agent.db");
    initDatabase({ dbPath });
    const session = {
      id: "archive_session",
      projectId: "p",
      workingDirectory: directory,
      title: "历史",
      agentName: "build",
      status: "archived" as const,
      createdAt: 1000,
      updatedAt: 2000,
      stats: { messageCount: 1 },
      childrenIds: [],
      isSubagent: false,
    };
    await createDatabaseSessionStore().insert(session);
    const manager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
      now: () => 3000,
    });
    const message = await manager.createMessage({
      sessionId: session.id,
      role: "user",
      agent: "build",
    });
    await manager.appendPart(message.id, { type: "text", text: "历史正文 👋" });
    const backend = createPersistentUiBackendClient({
      dbPath,
      workdir: directory,
      now: () => new Date("2026-10-17T07:30:12Z"),
      startupSessionMode: { type: "fresh" },
    });
    const app = createDaemonServerApp({ authToken: "export-token", backend });
    await app.start();
    const server = await listenToNodeServer({
      app: app.app,
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const headers = {
        authorization: "Bearer export-token",
        "x-ohbaby-client-id": "http_export",
        "content-type": "application/json",
      };
      const registration = await fetch(`${server.url}/v1/clients`, {
        method: "POST",
        headers,
        body: JSON.stringify({ clientId: "http_export" }),
      });
      expect(registration.status).toBe(200);
      const selected = await backend.getSelectedSessionId();
      expect(selected).not.toBe(session.id);
      const db = getDatabase();
      const snapshot = (): unknown[] =>
        [
          schema.session.tableName,
          schema.message.tableName,
          schema.part.tableName,
        ].map((table) =>
          db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        );
      const before = snapshot();
      const events: unknown[] = [];
      const unsubscribe = backend.subscribeEvents((event) =>
        events.push(event),
      );
      for (const format of ["html", "jsonl"] as const) {
        const rest = await fetch(
          `${server.url}/v1/sessions/${session.id}/export?format=${format}`,
          { headers },
        );
        expect(rest.status).toBe(200);
        const restBody = (await rest.json()) as {
          export: { content: string; messageCount: number };
        };
        const rpc = await fetch(`${server.url}/api/rpc`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: "export",
            clientId: "http_export",
            method: "exportSession",
            params: [{ sessionId: session.id, format }],
          }),
        });
        expect(rpc.status).toBe(200);
        expect(await rpc.json()).toEqual({
          id: "export",
          ok: true,
          result: restBody.export,
        });
        expect(restBody.export.messageCount).toBe(1);
        if (format === "jsonl") {
          const lines = restBody.export.content
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line) as unknown);
          expect(lines[0]).toMatchObject({
            session: { id: session.id, status: "archived" },
          });
          expect(lines[1]).toMatchObject({
            role: "user",
            parts: [{ type: "text", text: "历史正文 👋" }],
          });
        } else {
          const payload =
            /<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
              restBody.export.content,
            )?.[1];
          if (!payload) throw new Error("Missing embedded session data");
          expect(
            JSON.parse(Buffer.from(payload.trim(), "base64").toString("utf8")),
          ).toMatchObject({
            messages: [
              { role: "user", parts: [{ type: "text", text: "历史正文 👋" }] },
            ],
          });
        }
      }
      const missing = await fetch(
        `${server.url}/v1/sessions/missing/export?format=html`,
        { headers },
      );
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({
        error: { code: "SESSION_NOT_FOUND" },
      });
      expect(await backend.getSelectedSessionId()).toBe(selected);
      expect(snapshot()).toEqual(before);
      expect(events).toEqual([]);
      unsubscribe();
    } finally {
      await app.dispose();
      await server.stop();
      await backend.dispose();
      closeDatabase();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
