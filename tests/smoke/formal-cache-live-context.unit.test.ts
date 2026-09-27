import type {
  UiSnapshot,
  UiConnectModelResult,
  UiCurrentModelConfig,
  UiProbeModelContextWindowResult,
  UiPromptReceipt,
  UiPromptCompletion,
} from "ohbaby-sdk";
import { randomUUID } from "node:crypto";
import { currentDiscoveryState } from "../../packages/ohbaby-agent/src/config/llm/apply-active-model-config.js";
import { createDaemonServerApp } from "../../packages/ohbaby-server/src/app/create-app.js";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFormalCacheSession } from "./formal-cache-session.js";
import {
  LIVE_CONTEXT_PROFILES,
  createCompactionNotes,
  safeLiveContextFailure,
  classifyControlledRead,
  decideControlledPermission,
} from "./formal-cache-live-context.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("selects the three current protocol profiles", () => {
  expect(
    LIVE_CONTEXT_PROFILES.map(({ model, protocol }) => [model, protocol]),
  ).toEqual([
    ["deepseek/deepseek-v4.1-flash", "openai-compatible"],
    ["openai/gpt-5.6-luna", "openai-responses"],
    ["anthropic/claude-sonnet-5", "anthropic"],
  ]);
});

it("reduces a provider error containing a synthetic secret to a safe phase and code", () => {
  const summary = safeLiveContextFailure(
    new Error("upstream body leaked SYNTHETIC_SECRET_123 and private prompt"),
    "first-read",
  );
  expect(summary).toEqual({ phase: "first-read", code: "LIVE_RUN_FAILED" });
  expect(JSON.stringify(summary)).not.toContain("SYNTHETIC_SECRET_123");
});

it("allows only the exact local read path and records no argument values", () => {
  const workdir = join(tmpdir(), "controlled-workspace");
  const allowedFile = join(workdir, "cache-note.md");
  const allowed = classifyControlledRead(
    { name: "read", input: { file_path: "cache-note.md" } },
    workdir,
    allowedFile,
  );
  expect(allowed.allowed).toBe(true);
  expect(
    classifyControlledRead(
      { name: "read", input: { file_path: allowedFile } },
      workdir,
      allowedFile,
    ).allowed,
  ).toBe(true);
  for (const call of [
    { name: "read", input: { file_path: "../private.md" } },
    { name: "read", input: { file_path: "cache-note.md", offset: 1 } },
    {
      name: "bash",
      input: { command: "cat cache-note.md SYNTHETIC_SECRET_123" },
    },
    undefined,
  ]) {
    const denied = classifyControlledRead(call, workdir, allowedFile);
    expect(denied.allowed).toBe(false);
    expect(JSON.stringify(denied)).not.toContain("SYNTHETIC_SECRET_123");
    expect(denied.inputSha256).toMatch(/^[a-f0-9]{64}$/);
  }
});

it("chooses one-time allow for the controlled read and deny for another tool", () => {
  const workdir = join(tmpdir(), "controlled-workspace");
  const allowedFile = join(workdir, "cache-note.md");
  const request = {
    id: "permission-1",
    runId: "run-1",
    title: "private title",
    description: "private description",
    choices: [
      { id: "allow_always", label: "Always allow", intent: "allow" as const },
      { id: "allow_once", label: "Allow", intent: "allow" as const },
      { id: "deny-once", label: "Deny", intent: "deny" as const },
    ],
  };
  const snapshot = (
    name: string,
    input: Record<string, unknown>,
  ): UiSnapshot => ({
    runs: [
      {
        id: "run-1",
        sessionId: "session-1",
        status: {
          kind: "waiting-for-permission" as const,
          requestId: "permission-1",
        },
        startedAt: "",
        updatedAt: "",
      },
    ],
    sessions: [
      {
        id: "session-1",
        title: "",
        createdAt: "",
        updatedAt: "",
        messages: [
          {
            id: "message-1",
            role: "assistant" as const,
            createdAt: "",
            parts: [
              {
                type: "tool-call" as const,
                call: { id: "call-1", name, input, status: "pending" as const },
              },
            ],
          },
        ],
      },
    ],
    activeSessionId: "session-1",
    permissions: [],
    status: { kind: "idle" as const },
  });
  const allowed = decideControlledPermission(
    request,
    snapshot("read", { file_path: "cache-note.md" }),
    workdir,
    allowedFile,
  );
  expect(allowed).toMatchObject({
    choiceId: "allow_once",
    decision: { allowed: true },
  });
  const denied = decideControlledPermission(
    request,
    snapshot("bash", { command: "echo SYNTHETIC_SECRET_123" }),
    workdir,
    allowedFile,
  );
  expect(denied).toMatchObject({
    choiceId: "deny-once",
    decision: { allowed: false, toolName: "bash" },
  });
  expect(JSON.stringify(denied)).not.toContain("SYNTHETIC_SECRET_123");
  const skill = decideControlledPermission(
    request,
    snapshot("skill", { name: "SYNTHETIC_SECRET_123" }),
    workdir,
    allowedFile,
  );
  expect(skill).toMatchObject({
    choiceId: "deny-once",
    decision: { allowed: false, toolName: "skill" },
  });
  expect(JSON.stringify(skill)).not.toContain("SYNTHETIC_SECRET_123");
  expect(() =>
    decideControlledPermission(
      {
        ...request,
        choices: request.choices.filter((choice) => choice.id !== "allow_once"),
      },
      snapshot("read", { file_path: "cache-note.md" }),
      workdir,
      allowedFile,
    ),
  ).toThrow("NO_SAFE_PERMISSION_CHOICE");
});

it("uses detected production metadata for the real context limit and counts the probe", async () => {
  vi.stubEnv("ZENMUX_API_KEY", "fixture-only");
  const calls: string[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    return Response.json({
      data: [{ id: "deepseek/deepseek-v4.1-flash", context_length: 262144 }],
    });
  });
  const session = await createFormalCacheSession("zenmux-deepseek-v41-chat", {
    requireDetectedWindow: true,
    maxRequests: 20,
  });
  try {
    expect(session.contextWindow).toEqual({
      tokens: 262144,
      source: "detected",
    });
    expect(session.wire).toMatchObject([{ kind: "metadata", sequence: 1 }]);
    expect(calls).toEqual(["GET /api/v1/models"]);
  } finally {
    await session.close();
    await rm(session.root, { recursive: true, force: true });
  }
});

it("fails closed when metadata cannot detect a real window", async () => {
  vi.stubEnv("ZENMUX_API_KEY", "fixture-only");
  vi.stubGlobal("fetch", () => Response.json({ data: [] }));
  await expect(
    createFormalCacheSession("zenmux-deepseek-v41-chat", {
      requireDetectedWindow: true,
      maxRequests: 20,
    }),
  ).rejects.toThrow("detected context window");
});

it("reopens the same SQLite session and continues without resetting observed requests", async () => {
  vi.stubEnv("ZENMUX_API_KEY", "fixture-only");
  let generations = 0;
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    if (init?.method === "GET")
      return Response.json({
        data: [{ id: "deepseek/deepseek-v4.1-flash", context_length: 262144 }],
      });
    generations += 1;
    const frame = {
      id: `fixture-${String(generations)}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek/deepseek-v4.1-flash",
      choices: [
        {
          index: 0,
          delta: { content: "Cedar release 17 belongs to Lin." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
    };
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const session = await createFormalCacheSession("zenmux-deepseek-v41-chat", {
    requireDetectedWindow: true,
    maxRequests: 20,
  });
  try {
    const before = await session.submit(
      "Say the project name. Do not use tools.",
    );
    expect(session.contextUpdates.length).toBeGreaterThan(0);
    expect(
      session.contextUpdates.every(
        (usage) => usage.contextWindowTokens === 262144,
      ),
    ).toBe(true);
    const firstSessionId = before.checkpoint.cache.sessionId;
    const usageBefore = (
      await session.backend.getSnapshot()
    ).contextWindowUsages?.find((usage) => usage.sessionId === firstSessionId);
    expect(usageBefore?.contextWindowTokens).toBe(262144);
    expect(usageBefore?.currentTokens).toBeGreaterThan(0);
    const nativeBefore = session.activeNativeFingerprint();
    expect(typeof nativeBefore.count).toBe("number");
    expect(nativeBefore.sha256).toMatch(/^[a-f0-9]{64}$/);
    const requestsBefore = session.wire.length;
    await session.reopen();
    expect(session.activeNativeFingerprint()).toEqual(nativeBefore);
    const after = await session.submit("Confirm the owner. Do not use tools.");
    const usageReopened = (
      await session.backend.getSnapshot()
    ).contextWindowUsages?.find((usage) => usage.sessionId === firstSessionId);
    expect(usageReopened?.contextWindowTokens).toBe(262144);
    expect(usageReopened?.currentTokens).toBeGreaterThan(0);
    expect(after.checkpoint.cache.sessionId).toBe(firstSessionId);
    expect(session.wire.length).toBeGreaterThan(requestsBefore);
    expect(after.checkpoint.persisted.runs).toHaveLength(2);
  } finally {
    await session.close();
    await rm(session.root, { recursive: true, force: true });
  }
}, 30000);

it.each([
  { label: "retained native states", firstOnly: false },
  { label: "no active native states", firstOnly: true },
])(
  "records summary retirement and reopens with $label",
  async ({ firstOnly }) => {
    vi.stubEnv("ZENMUX_API_KEY", "fixture-only");
    let main = 0;
    let sequence = 0;
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      if (init?.method === "GET")
        return Response.json({
          data: [
            { id: "deepseek/deepseek-v4.1-flash", context_length: 262144 },
          ],
        });
      if (typeof init?.body !== "string")
        throw new Error("Expected fixture JSON body");
      const body = JSON.parse(init.body) as { tools?: unknown[] };
      const agent = (body.tools?.length ?? 0) > 0;
      if (agent) main += 1;
      sequence += 1;
      const tool = agent && main === 1;
      const frame = {
        id: `fixture-summary-${String(sequence)}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek/deepseek-v4.1-flash",
        choices: [
          {
            index: 0,
            delta: tool
              ? {
                  reasoning_content: `Fixture reasoning ${String(sequence)}`,
                  tool_calls: [
                    {
                      index: 0,
                      id: "fixture-read",
                      type: "function",
                      function: {
                        name: "read",
                        arguments: JSON.stringify({
                          file_path: "cache-note.md",
                        }),
                      },
                    },
                  ],
                }
              : {
                  content: "Cedar release 17 belongs to Lin.",
                  ...(agent && !firstOnly
                    ? {
                        reasoning_content: `Fixture reasoning ${String(sequence)}`,
                      }
                    : {}),
                },
            finish_reason: tool ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
      };
      return new Response(
        `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    const session = await createFormalCacheSession("zenmux-deepseek-v41-chat", {
      requireDetectedWindow: true,
      maxRequests: 20,
    });
    try {
      await session.submit(
        "Remember Cedar release 17 and owner Lin." + createCompactionNotes(30),
      );
      await session.submit(
        "Confirm Cedar release 17 and owner Lin." + createCompactionNotes(60),
      );
      await session.submit(
        "Restate Cedar release 17 and owner Lin. Do not use tools.",
      );
      const toolCheckpoint = await session.checkpoint(
        "controlled-tool-evidence",
      );
      expect(toolCheckpoint.persisted.completedTools).toEqual([
        expect.objectContaining({
          allowed: true,
          toolName: "read",
          inputKeys: ["file_path"],
        }),
      ]);
      // Readonly execution may bypass permission prompts; durable records must still be checked.
      expect(session.permissionDecisions).toEqual([]);
      const toolsBefore = session.allToolPartIds();
      expect(toolsBefore.ids.length).toBeGreaterThan(0);
      const nativeBefore = session.nativeStateHashes("before-compaction");
      expect(nativeBefore.active.length).toBeGreaterThan(0);
      const compact = await session.compact();
      expect(compact.result.status).toBe("compacted");
      expect(compact.checkpoint.persisted.context.summaryParts).toBeGreaterThan(
        0,
      );
      expect(compact.checkpoint.persisted.context.retiredParts).toBeGreaterThan(
        0,
      );
      expect(
        compact.checkpoint.persisted.context.retiredNativeParts,
      ).toBeGreaterThan(0);
      expect(session.allToolPartIds()).toEqual(toolsBefore);
      const nativeAfter = session.nativeStateHashes("after-compaction");
      expect(nativeAfter.retired.length).toBeGreaterThan(0);
      expect(nativeAfter.active).not.toContain(nativeAfter.retired[0]);
      if (firstOnly) expect(nativeAfter.active).toEqual([]);
      else expect(nativeAfter.active.length).toBeGreaterThan(0);
      await session.submit("Confirm the owner from the summary without tools.");
      const replay = session.providerRequests
        .filter((request) => request.purpose === "agent-step")
        .at(-1);
      expect(replay?.replayStateHashes).toEqual(nativeAfter.active);
      expect(session.allToolPartIds()).toEqual(toolsBefore);
      const beforeReopen = session.nativeStateHashes("before-reopen");
      const fingerprint = session.activeNativeFingerprint("before-reopen");
      if (firstOnly) expect(fingerprint.count).toBe(0);
      await session.reopen();
      expect(session.nativeStateHashes("after-reopen")).toEqual(beforeReopen);
      expect(session.activeNativeFingerprint("after-reopen")).toEqual(
        fingerprint,
      );
      await session.submit(
        "Confirm Cedar and Lin after reopening. Do not use tools.",
      );
      const reopenedReplay = session.providerRequests
        .filter((request) => request.purpose === "agent-step")
        .at(-1);
      expect(reopenedReplay?.replayStateHashes).toEqual(beforeReopen.active);
      expect(
        reopenedReplay?.replayStateHashes.some((hash) =>
          beforeReopen.retired.includes(hash),
        ),
      ).toBe(false);
      expect(session.allToolPartIds()).toEqual(toolsBefore);
      expect(
        session.providerRequests.some(
          (item) => item.purpose === "context-summary",
        ),
      ).toBe(true);
    } finally {
      await session.close();
      await rm(session.root, { recursive: true, force: true });
    }
  },
  30000,
);

it("awaits the public metadata probe when seeded reasoning is already identified before discovery finishes", async () => {
  vi.stubEnv("ZENMUX_API_KEY", "fixture-only");
  const metadataResponses: ((response: Response) => void)[] = [];
  let generations = 0;
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    if (init?.method === "GET")
      return new Promise<Response>((resolve) =>
        metadataResponses.push(resolve),
      );
    const frame = {
      id: `fixture-${String(++generations)}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "openai/gpt-5.6-luna",
      choices: [
        {
          index: 0,
          delta: { content: "Cedar release 17 belongs to Lin." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
    };
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  // Match the live protocol test exactly: GPT profile, seeded capabilities and
  // 128000 fallback, public connect, then close/reopen the same SQLite database.
  const session = await createFormalCacheSession("zenmux-gpt56-luna-chat", {
    maxRequests: 20,
  });
  const authToken = randomUUID();
  const clientId = randomUUID();
  let handle = createDaemonServerApp({
    backend: session.backend,
    authToken,
    commandRecorder: false,
  });
  let sessionId: string | undefined;
  async function request<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await handle.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${authToken}`,
        "x-ohbaby-client-id": clientId,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.ok).toBe(true);
    return response.json() as Promise<T>;
  }
  async function start(): Promise<void> {
    await handle.start();
    await request("/v1/clients", "POST", {
      clientId,
      ...(sessionId ? { startupIntent: { resumeSessionId: sessionId } } : {}),
    });
  }
  async function submit(): Promise<void> {
    const receipt = await request<UiPromptReceipt>("/v1/prompts", "POST", {
      text: "Report Project, Release and Owner. Do not use tools.",
      clientRequestId: randomUUID(),
      ...(sessionId ? { sessionId } : {}),
    });
    sessionId = receipt.sessionId;
    const { completion } = await request<{ completion: UiPromptCompletion }>(
      `/v1/prompts/${receipt.promptId}/completion`,
    );
    expect(completion.prompt.status).toBe("succeeded");
    const { snapshot } = await request<{ snapshot: UiSnapshot }>(
      "/v1/snapshot",
    );
    const usage = snapshot.contextWindowUsages?.find(
      (item) => item.sessionId === sessionId,
    );
    expect(usage?.contextWindowTokens).toBe(1050000);
    expect(usage?.currentTokens).toBeGreaterThan(0);
  }
  try {
    await start();
    const input = {
      provider: "zenmux",
      model: "openai/gpt-5.6-luna",
      interfaceProvider: "openai-compatible",
      baseUrl: "https://zenmux.ai/api/v1",
      apiKeyEnv: "ZENMUX_API_KEY",
      contextWindowTokens: 128000,
      maxOutputTokens: 4096,
    };
    const { model: saved } = await request<{ model: UiConnectModelResult }>(
      "/v1/model",
      "POST",
      input,
    );
    expect(saved).toMatchObject({
      contextWindowTokens: 128000,
      contextWindowSource: "user",
    });
    await vi.waitFor(() => expect(metadataResponses).toHaveLength(1));
    const { model: initial } = await request<{ model: UiCurrentModelConfig }>(
      "/v1/model",
    );
    expect(initial.reasoning?.status).toBe("identified");
    expect(initial.contextWindowTokens).toBe(128000);
    const pendingProbe = request<{ probe: UiProbeModelContextWindowResult }>(
      "/v1/model/context-window-probe",
      "POST",
      input,
    );
    await vi.waitFor(() => expect(metadataResponses).toHaveLength(2));
    for (const resolve of metadataResponses)
      resolve(
        Response.json({
          data: [{ id: "openai/gpt-5.6-luna", context_length: 1050000 }],
        }),
      );
    const { probe } = await pendingProbe;
    expect(probe).toMatchObject({
      contextWindowTokens: 1050000,
      contextWindowSource: "detected",
    });
    const { model: current } = await request<{ model: UiCurrentModelConfig }>(
      "/v1/model",
    );
    expect(current.contextWindowTokens).toBe(probe.contextWindowTokens);
    await submit();
    await handle.dispose();
    await session.reopen();
    handle = createDaemonServerApp({
      backend: session.backend,
      authToken,
      commandRecorder: false,
    });
    await start();
    const { model: reopened } = await request<{ model: UiCurrentModelConfig }>(
      "/v1/model",
    );
    expect(reopened.contextWindowTokens).toBe(probe.contextWindowTokens);
    await submit();
  } finally {
    // Resolve the controlled transport even if an assertion fails before probe.
    for (const resolve of metadataResponses)
      resolve(Response.json({ data: [] }));
    await vi.waitFor(async () => {
      expect((await currentDiscoveryState())?.status).not.toBe("detecting");
    });
    await handle.dispose();
    await session.close();
    await rm(session.root, { recursive: true, force: true });
  }
}, 30000);
