import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createInProcessUiBackendClient } from "../../../../packages/ohbaby-agent/src/adapters/ui-inprocess.js";
import {
  createModelEntry,
  readModelSettings,
  selectModelEntry,
  updateModelEntry,
} from "../../../../packages/ohbaby-agent/src/config/llm/writer.js";
import { LLMConfigManager } from "../../../../packages/ohbaby-agent/src/config/llm/manager.js";
import { closeDatabase } from "../../../../packages/ohbaby-agent/src/services/database/index.js";

it("keeps incompatible model settings readable, rejects its new runs, and recovers after fixing the override", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-budget-admission-"));
  vi.stubEnv("OHBABY_HOME", join(root, "home"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("CODEX_HOME", join(root, "codex"));
  LLMConfigManager.resetInstance();
  const requests: Record<string, unknown>[] = [];
  const upstream = createServer((request, response) => {
    void (async (): Promise<void> => {
      if (request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      if (body.stream !== true) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "No reasoning parameters" } }),
        );
        return;
      }
      if (!JSON.stringify(body).includes("Write a short conversation title"))
        requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { content: "Done" }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture endpoint");
  const baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;
  let client: ReturnType<typeof createInProcessUiBackendClient> | undefined;
  try {
    const common = {
      provider: "budget-fixture",
      baseUrl,
      interfaceProvider: "openai-compatible" as const,
      apiKeyEnv: null,
    };
    const invalid = (
      await createModelEntry({
        ...common,
        model: "small",
        contextWindowTokens: 16000,
      })
    ).models.find((model) => model.model === "small");
    if (!invalid) throw new Error("Missing incompatible entry");
    expect(invalid.tokenBudgetIssue).toEqual({
      code: "MODEL_TOKEN_LIMITS_INCOMPATIBLE",
      contextWindowTokens: 16000,
      maxOutputTokens: 32768,
    });
    const good = (
      await createModelEntry({
        ...common,
        model: "large",
        contextWindowTokens: 100000,
      })
    ).models.find((model) => model.model === "large");
    if (!good) throw new Error("Missing compatible entry");
    expect((await readModelSettings()).models).toHaveLength(2);
    await selectModelEntry(invalid.id);
    const workdir = join(root, "workspace");
    await mkdir(workdir);
    client = createInProcessUiBackendClient({ workdir });
    expect(await client.getCurrentModel()).toMatchObject({
      id: invalid.id,
      contextWindowTokens: 16000,
      effectiveContextWindowTokens: 16000,
      effectiveMaxOutputTokens: 32768,
      tokenBudgetIssue: { code: "MODEL_TOKEN_LIMITS_INCOMPATIBLE" },
    });
    const rejected = await client.submitPromptAndWait(
      "Do not call the incompatible model",
      { sessionId: "invalid-budget" },
    );
    expect(rejected.prompt).toMatchObject({
      status: "failed",
      error: { code: "MODEL_TOKEN_LIMITS_INCOMPATIBLE" },
    });
    expect(requests).toEqual([]);
    await selectModelEntry(good.id);
    const accepted = await client.submitPromptAndWait(
      "Use the compatible model",
      { sessionId: "valid-budget" },
    );
    expect(accepted.prompt.status).toBe("succeeded");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: "large", max_tokens: 32768 });
    const fixed = await updateModelEntry(invalid.id, { maxOutputTokens: 4096 });
    expect(
      fixed.models.find((model) => model.id === invalid.id),
    ).not.toHaveProperty("tokenBudgetIssue");
    await selectModelEntry(invalid.id);
    const recovered = await client.submitPromptAndWait(
      "Use the repaired model",
      { sessionId: "repaired-budget" },
    );
    expect(recovered.prompt.status).toBe("succeeded");
    expect(requests.at(-1)).toMatchObject({ model: "small", max_tokens: 4096 });
  } finally {
    await client?.dispose();
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
