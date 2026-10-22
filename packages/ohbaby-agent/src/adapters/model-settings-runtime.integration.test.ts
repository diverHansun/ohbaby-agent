import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createInProcessUiBackendClient } from "./ui-inprocess.js";
import {
  createModelEntry,
  selectModelEntry,
  deleteModelEntry,
  updateModelEntry,
} from "../config/llm/writer.js";
import { LLMConfigManager } from "../config/llm/manager.js";
import { closeDatabase } from "../services/database/index.js";

it("normal loaders keep in-flight rounds on A then both workspaces use B's own protocol/key and refuse rounds after all entries are deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-settings-runtime-"));
  vi.stubEnv("OHBABY_HOME", join(root, "home"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  LLMConfigManager.resetInstance();
  const calls: { path: string; key: string; body: Record<string, unknown> }[] =
    [];
  const held: { response: ServerResponse; body: Record<string, unknown> }[] =
    [];
  function finish(
    response: ServerResponse,
    body: Record<string, unknown>,
    anthropic = false,
  ): void {
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (anthropic) {
      for (const event of [
        {
          type: "message_start",
          message: {
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [],
            model: body.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Done" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ])
        response.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      response.end();
    } else {
      response.write(
        `data: ${JSON.stringify({ id: "chatcmpl_test", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { content: "Done" }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: "chatcmpl_test", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    }
  }
  const upstream = createServer((request, response) => {
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    void (async (): Promise<void> => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Uint8Array));
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw) as Record<string, unknown>;
      const title = raw.includes("Write a short conversation title");
      if (!title)
        calls.push({
          path: request.url ?? "",
          key: String(
            request.headers.authorization ?? request.headers["x-api-key"],
          ),
          body,
        });
      if (
        !title &&
        request.url?.startsWith("/a/") &&
        raw.includes("stage4a-old")
      )
        held.push({ response, body });
      else finish(response, body, request.url?.startsWith("/b/"));
    })();
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const endpoint = `http://127.0.0.1:${String((upstream.address() as { port: number }).port)}`;
  const clients: ReturnType<typeof createInProcessUiBackendClient>[] = [];
  try {
    const a = (
      await createModelEntry({
        provider: "custom",
        model: "shared",
        baseUrl: endpoint + "/a/v1",
        interfaceProvider: "openai-compatible",
        apiKey: "runtime-key-a",
      })
    ).models[0];
    await selectModelEntry(a.id);
    for (const name of ["a", "b"]) {
      const workdir = join(root, name);
      await mkdir(workdir);
      clients.push(createInProcessUiBackendClient({ workdir }));
    }
    const old = clients.map((client, index) =>
      client.submitPromptAndWait("stage4a-old", {
        sessionId: `old-${String(index)}`,
      }),
    );
    await vi.waitFor(() => {
      expect(held).toHaveLength(2);
    });
    const b = (
      await createModelEntry({
        provider: "custom",
        model: "shared",
        baseUrl: endpoint + "/b",
        interfaceProvider: "anthropic",
        apiKey: "runtime-key-b",
      })
    ).models.at(-1);
    if (!b) throw new Error("Missing saved entry");
    await updateModelEntry(a.id, { label: "same connection" });
    await selectModelEntry(b.id);
    expect(calls.map((call) => call.key)).toEqual([
      "Bearer runtime-key-a",
      "Bearer runtime-key-a",
    ]);
    for (const pending of held) finish(pending.response, pending.body);
    await Promise.all(old);
    await Promise.all(
      clients.map((client, index) =>
        client.submitPromptAndWait("stage4a-next", {
          sessionId: `next-${String(index)}`,
        }),
      ),
    );
    expect(calls.slice(2).map((call) => [call.path, call.key])).toEqual([
      ["/b/v1/messages", "runtime-key-b"],
      ["/b/v1/messages", "runtime-key-b"],
    ]);
    for (const call of calls) {
      expect(call.body).not.toHaveProperty("reasoning");
      expect(call.body).not.toHaveProperty("reasoning_effort");
      expect(call.body).not.toHaveProperty("thinking");
    }
    await deleteModelEntry(b.id);
    await deleteModelEntry(a.id);
    const count = calls.length;
    const failed = await clients[0].submitPromptAndWait(
      "must not use deleted model",
      { sessionId: "deleted" },
    );
    expect(failed.prompt.status).toBe("failed");
    expect(failed.prompt.error?.message).toMatch(/model|configur/i);
    expect(calls).toHaveLength(count);
    expect(await clients[1].getCurrentModel()).toBeNull();
    const models = await clients[1].executeCommand({
      argv: [],
      clientInvocationId: "empty-models",
      commandId: "models",
      path: ["models"],
      raw: "/models",
      rawArgs: "",
      surface: "tui",
    });
    expect(models.status).toBe("completed");
  } finally {
    for (const pending of held) pending.response.end();
    await Promise.all(clients.map((client) => client.dispose()));
    upstream.closeAllConnections();
    await new Promise<void>((resolve) =>
      upstream.close(() => {
        resolve();
      }),
    );
    closeDatabase();
    LLMConfigManager.resetInstance();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
