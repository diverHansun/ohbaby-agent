import { expect, it, vi } from "vitest";
import { rm, access } from "node:fs/promises";
import { join } from "node:path";
import { createFormalCacheSession } from "../smoke/formal-cache-session.js";

it("uses the production prompt, read tool, persistence and public status while excluding title usage", async () => {
  let main = 0;
  vi.stubEnv("ZENMUX_API_KEY", "formal-fixture-key");
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", (_url: unknown, init?: RequestInit) => {
    if (init?.method === "GET")
      return Promise.resolve(
        Response.json({
          data: [{ id: "openai/gpt-5.6-luna", context_length: 128000 }],
        }),
      );
    if (typeof init?.body !== "string") throw new Error("Expected JSON body");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer formal-fixture-key",
    );
    const body = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(body);
    const agent = Array.isArray(body.tools) && body.tools.length > 0;
    if (agent) main += 1;
    const tool = agent && main === 1;
    const input = agent ? 10000 : 666;
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: "call_read",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ file_path: "cache-note.md" }),
              },
            },
          ],
        }
      : { content: agent ? "Cedar release 17 belongs to Lin." : "Cedar check" };
    const data = [
      {
        id: "chat_fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: null }],
      },
      {
        id: "chat_fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [
          { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" },
        ],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: input,
          completion_tokens: 10,
          total_tokens: input + 10,
          prompt_tokens_details: {
            cached_tokens: agent && main > 1 ? 8000 : 0,
          },
        },
      },
    ];
    return Promise.resolve(
      new Response(
        data.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
  });
  let session: Awaited<ReturnType<typeof createFormalCacheSession>> | undefined;
  try {
    session = await createFormalCacheSession("zenmux-gpt56-luna-chat-native");
    await session.submit(
      "Read cache-note.md and report the project and release. Use the read tool once.",
    );
    await session.submit(
      "Who owns this release? Answer from the existing conversation without tools.",
    );
    expect(main).toBe(3);
    const persisted = (await session.checkpoint("persisted-verification"))
      .persisted;
    expect(persisted.runs).toEqual([
      { status: "succeeded" },
      { status: "succeeded" },
    ]);
    expect(persisted.usageParts).toHaveLength(3);
    const storedInput = persisted.usageParts.reduce(
      (sum, part) => sum + part.usage.inputTokens,
      0,
    );
    const storedCacheRead = persisted.usageParts.reduce(
      (sum, part) => sum + (part.usage.inputBreakdown?.cacheRead ?? 0),
      0,
    );
    expect(await session.status()).toMatchObject({
      accountedInputTokens: storedInput,
      cacheReadTokens: storedCacheRead,
      cacheReadShare: storedCacheRead / storedInput,
    });
    expect(await session.status()).toMatchObject({
      accountedInputTokens: 30000,
      cacheReadTokens: 16000,
      cacheReadShare: 16000 / 30000,
    });
    expect(
      session.providerRequests.some((row) => row.purpose === "session-title"),
    ).toBe(true);
    const first = bodies.find(
      (body) => Array.isArray(body.tools) && body.tools.length > 0,
    );
    if (!first) throw new Error("Missing main request");
    expect(JSON.stringify(first.messages).length).toBeGreaterThan(3000);
    expect((first.tools as unknown[]).length).toBeGreaterThan(5);
    const snapshot = await session.backend.getSnapshot();
    expect(JSON.stringify(snapshot)).toContain("Cedar");
    expect(JSON.stringify(snapshot)).toContain("tool-result");
    expect(JSON.stringify(session.checkpoints)).toContain(
      '"status":"completed"',
    );
    const changed = await session.changeEffort("high");
    expect(changed.checkpoint.cache).toEqual(changed.before);
    await session.submit("Confirm the owner without tools.");
    expect(bodies.at(-1)?.reasoning_effort).toBe("high");
    expect(await session.status()).toMatchObject({
      accountedInputTokens: 40000,
      cacheReadTokens: 24000,
    });
  } finally {
    if (session) {
      await session.close();
      await rm(session.root, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
}, 30000);

it("refuses to save evidence while a real provider operation is active", async () => {
  vi.stubEnv("ZENMUX_API_KEY", "formal-fixture-key");
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let releaseResponse!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  vi.stubGlobal("fetch", async () => {
    notifyStarted();
    await release;
    return new Response(
      `data: ${JSON.stringify({
        id: "chat_fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "openai/gpt-5.6-luna",
        choices: [
          { index: 0, delta: { content: "Ready" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  let session: Awaited<ReturnType<typeof createFormalCacheSession>> | undefined;
  let submission:
    | ReturnType<NonNullable<typeof session>["backend"]["submitPromptAndWait"]>
    | undefined;
  try {
    session = await createFormalCacheSession("zenmux-gpt56-luna-chat-native");
    submission = session.backend.submitPromptAndWait(
      "Say ready without tools.",
    );
    await started;
    const path = join(session.root, "active-evidence.json");
    await expect(session.save(path)).rejects.toThrow(
      "Provider operation still active",
    );
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    releaseResponse();
    try {
      await submission;
      if (session) {
        await session.close();
        await rm(session.root, { recursive: true, force: true });
      }
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  }
}, 30000);
