import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createInProcessUiBackendClient } from "ohbaby-agent";
import { createDaemonServerApp } from "ohbaby-server";
import { createOhbabyWebRuntime } from "../../runtime.js";

interface Fixture {
  runtime: ReturnType<typeof createOhbabyWebRuntime>;
  other: ReturnType<typeof createOhbabyWebRuntime>;
  backend: ReturnType<typeof createInProcessUiBackendClient>;
  server: ReturnType<typeof createDaemonServerApp>;
  directory: string;
  releaseTitle(): void;
  commandRequests(): number;
  readonly titleStarted: () => boolean;
  dispose(): Promise<void>;
}
interface FixtureEvent {
  textDelta?: string;
  finishReason: "stop" | "tool_calls";
  toolCallDeltas?: {
    index: number;
    id: string;
    name: string;
    argumentsDelta: string;
  }[];
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Required fixture value missing");
  return value;
}
async function fixture(loseCommandResponse = false): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "command-lifecycle-"));
  await mkdir(join(directory, ".ohbaby", "skill", "review"), {
    recursive: true,
  });
  await writeFile(
    join(directory, ".ohbaby", "skill", "review", "SKILL.md"),
    "---\nname: review\ndescription: Test review\n---\nReview this workspace.",
  );
  let releaseTitle!: () => void;
  const titleGate = new Promise<void>((resolve) => {
    releaseTitle = resolve;
  });
  let titleStarted = false;
  const backend = createInProcessUiBackendClient({
    workdir: directory,
    projectDirectory: directory,
    llmClient: {
      config: {
        apiKeyEnv: "TEST_KEY",
        baseUrl: "https://invalid.test",
        interfaceProvider: "openai-compatible",
        maxTokens: 100,
        model: "fake-model",
        provider: "openai",
        temperature: 0,
      },
      provider: {
        client: {},
        id: "fake",
        kind: "openai-compatible",
        isAbortError: () => false,
        streamResponse(request): Promise<AsyncIterable<FixtureEvent>> {
          const title = request.messages.some(
            (message) =>
              typeof message.content === "string" &&
              message.content.includes("Write a short conversation title"),
          );
          if (title) titleStarted = true;
          return Promise.resolve(
            (async function* (): AsyncGenerator<FixtureEvent, void, unknown> {
              if (title) {
                await titleGate;
                yield {
                  textDelta: "Reviewed workspace",
                  finishReason: "stop" as const,
                };
              } else
                yield {
                  finishReason: "tool_calls" as const,
                  toolCallDeltas: [
                    {
                      index: 0,
                      id: "approval-call",
                      name: "bash",
                      argumentsDelta: JSON.stringify({
                        command: "echo fixture > never-run.txt",
                      }),
                    },
                  ],
                };
            })(),
          );
        },
      },
    },
  });
  const server = createDaemonServerApp({ backend, authToken: "test-token" });
  await server.start();
  let commandRequests = 0;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const response = await server.app.request(`${url.pathname}${url.search}`, {
      body: init.body,
      headers: init.headers,
      method: init.method,
      signal: init.signal,
    });
    if (url.pathname === "/v1/commands" && init.method === "POST") {
      commandRequests += 1;
      if (loseCommandResponse) throw new Error("lost response");
    }
    return response;
  };
  const runtime = createOhbabyWebRuntime(
    {
      baseUrl: "http://localhost",
      directory,
      clientId: "owner",
      token: "test-token",
      startupIntent: { startupSessionMode: { type: "fresh" } },
    },
    { fetch: fetchImpl },
  );
  const other = createOhbabyWebRuntime(
    {
      baseUrl: "http://localhost",
      directory,
      clientId: "other",
      token: "test-token",
      startupIntent: { startupSessionMode: { type: "fresh" } },
    },
    { fetch: fetchImpl },
  );
  await Promise.all([runtime.ready, other.ready]);
  return {
    runtime,
    other,
    backend,
    server,
    directory,
    releaseTitle,
    commandRequests: (): number => commandRequests,
    titleStarted: (): boolean => titleStarted,
    async dispose(): Promise<void> {
      releaseTitle();
      await Promise.all([runtime.dispose(), other.dispose()]);
      await server.dispose();
      await backend.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("real command acceptance and Web consumers", () => {
  it("queries an accepted skill after a lost response without replaying the command", async () => {
    const f = await fixture(true);
    try {
      await expect(
        f.runtime.executeSlashCommand({
          text: "/review inspect",
          clientRequestId: "lost-receipt",
        }),
      ).rejects.toThrow("unconfirmed");
      expect(f.runtime.store.getSnapshot().unknownPromptRequests).toHaveLength(
        1,
      );
      await waitFor(
        () =>
          f.runtime.store.getSnapshot().permissionSync.requests.length === 1,
        "lost response lost its binding",
      );
      await f.runtime.retryUnknownPrompts();
      expect(f.runtime.store.getSnapshot().unknownPromptRequests).toEqual([]);
      expect(f.commandRequests()).toBe(1);
      const sessionId = required(
        required(f.runtime.store.getSnapshot().permissionSync.binding)
          .rootSessionId,
      );
      await f.runtime.abortSession(sessionId);
    } finally {
      await f.dispose();
    }
  });

  it.each(["success", "failed"] as const)(
    "does not revive a late %s command when switching A to B and back",
    async (outcome) => {
      const f = await fixture();
      try {
        await f.runtime.createSession();
        const first = required(
          required(f.runtime.store.getSnapshot().permissionSync.binding)
            .rootSessionId,
        );
        await f.runtime.createSession();
        const second = required(
          required(f.runtime.store.getSnapshot().permissionSync.binding)
            .rootSessionId,
        );
        await f.runtime.selectSession(first);
        await waitFor(
          () => f.runtime.store.getSnapshot().sessionSync.status === "ready",
          "session not ready",
        );
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const original = f.backend.executeCommand.bind(f.backend);
        let entered = false;
        vi.spyOn(f.backend, "executeCommand").mockImplementation(
          async (invocation) => {
            entered = true;
            await gate;
            return original(invocation);
          },
        );
        const pending = f.runtime.executeSlashCommand({
          sessionId: first,
          text: outcome === "success" ? "/help" : "/goal budget 100",
          allowOverlay: outcome === "failed",
        });
        await waitFor(() => entered, "command did not enter handler");
        await f.runtime.selectSession(second);
        release();
        await pending;
        expect(f.runtime.store.getSnapshot().view.commandNotices).toEqual([]);
        await f.runtime.selectSession(first);
        expect(f.runtime.store.getSnapshot().view.commandNotices).toEqual([]);
      } finally {
        await f.dispose();
      }
    },
  );
  it("returns the same completion contract for RPC new and resume special branches", async () => {
    const f = await fixture();
    try {
      for (const [id, args, status] of [
        ["new", [], "completed"],
        ["resume", [], "failed"],
        ["new", ["--bad"], "failed"],
      ] as const) {
        const response = await f.server.app.request("/api/rpc", {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            id: `rpc-${id}-${String(args.length)}`,
            clientId: "owner",
            method: "executeCommand",
            params: [
              {
                clientInvocationId: "rpc-command",
                commandId: id,
                path: [id],
                raw: `/${id}`,
                rawArgs: args.join(" "),
                argv: args,
                surface: "tui",
              },
            ],
          }),
        });
        expect(await response.json()).toMatchObject({
          ok: true,
          result: {
            status,
            clientInvocationId: "rpc-command",
            outputCount: status === "completed" ? 1 : 0,
            eventCount: status === "completed" ? 2 : 1,
          },
        });
      }
    } finally {
      await f.dispose();
    }
  });
  it("keeps the real goal failure in the overlay rejection when its HTTP response is lost", async () => {
    const f = await fixture(true);
    try {
      await f.runtime.createSession();
      await waitFor(
        () => f.runtime.store.getSnapshot().sessionSync.status === "ready",
        "session not ready",
      );
      await expect(
        f.runtime.executeSlashCommand({
          allowOverlay: true,
          text: "/goal budget 100",
        }),
      ).rejects.toThrow(/budget[\s\S]*unconfirmed/);
      expect(f.runtime.store.getSnapshot().view.commandNotices).toEqual([]);
      expect(f.commandRequests()).toBe(1);
    } finally {
      await f.dispose();
    }
  });
  it("returns failed completion for real goal fail at HTTP 200 without a chat card", async () => {
    const f = await fixture();
    try {
      await f.runtime.createSession();
      await waitFor(
        () => f.runtime.store.getSnapshot().sessionSync.status === "ready",
        "session not ready",
      );
      const sessionId = required(
        required(f.runtime.store.getSnapshot().permissionSync.binding)
          .rootSessionId,
      );
      const completion = await f.runtime.executeSlashCommand({
        allowOverlay: true,
        sessionId,
        text: "/goal budget 100",
      });
      expect(completion.status).toBe("failed");
      if (completion.status !== "failed")
        throw new Error("Expected failed completion");
      expect(completion.error.message).toContain("budget");
      expect(f.runtime.store.getSnapshot().view.commandNotices).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
  it("accepts an implicit skill once, routes approval and Stop to its original client and preserves receipt identity", async () => {
    const f = await fixture();
    try {
      const completion = await f.runtime.executeSlashCommand({
        text: "/review inspect scope",
        clientRequestId: "stable-skill-request",
      });
      expect(completion).toMatchObject({
        status: "completed",
        outputCount: 0,
        promptReceipt: { clientRequestId: "stable-skill-request" },
      });
      const receipt = required(completion.promptReceipt);
      await waitFor(
        () =>
          f.runtime.store.getSnapshot().permissionSync.requests.length === 1,
        "skill approval not routed to original owner",
      );
      expect(
        f.runtime.store.getSnapshot().permissionSync.binding?.rootSessionId,
      ).toBe(receipt.sessionId);
      expect(f.other.store.getSnapshot().permissionSync.requests).toEqual([]);
      expect(
        f.other.store.getSnapshot().permissionSync.binding?.rootSessionId,
      ).toBeNull();
      expect(f.runtime.store.getSnapshot().view.commandNotices).toEqual([]);
      const binding = required(
        f.runtime.store.getSnapshot().permissionSync.binding,
      );
      const client = required(f.runtime.client);
      if (!client.getPromptReceipt) throw new Error("Missing receipt query");
      const queried = await client.getPromptReceipt({
        clientRequestId: "stable-skill-request",
        runtimeEpoch: binding.permissionEpoch,
        bindingGeneration: binding.bindingGeneration,
      });
      expect(queried.receipt?.promptId).toBe(receipt.promptId);
      await f.runtime.abortSession(receipt.sessionId);
      await waitFor(
        () =>
          f.runtime.store.getSnapshot().permissionSync.requests.length === 0,
        "Stop did not clear approval",
      );
      expect(f.runtime.store.getSnapshot().view.commandNotices).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
  it("refreshes the sidebar index for provisional and late offscreen generated skill titles", async () => {
    const f = await fixture();
    try {
      await f.runtime.createSession();
      await waitFor(
        () => f.runtime.store.getSnapshot().sessionSync.status === "ready",
        "session not ready",
      );
      const sessionId = required(
        required(f.runtime.store.getSnapshot().permissionSync.binding)
          .rootSessionId,
      );
      expect(
        f.runtime.store
          .getSnapshot()
          .sessionIndex.find((row) => row.id === sessionId)?.title,
      ).toBe("New session");
      await f.runtime.executeSlashCommand({
        sessionId,
        text: "/review inspect scope",
        clientRequestId: "title-request",
      });
      await waitFor(
        () =>
          f.runtime.store
            .getSnapshot()
            .sessionIndex.find((row) => row.id === sessionId)?.title ===
          "inspect scope",
        "provisional title did not reach sidebar index",
      );
      await waitFor(f.titleStarted, "title generation did not start");
      await f.runtime.abortSession(sessionId);
      await f.runtime.createSession();
      const selected = required(
        f.runtime.store.getSnapshot().permissionSync.binding,
      ).rootSessionId;
      expect(selected).not.toBe(sessionId);
      f.releaseTitle();
      await waitFor(
        () =>
          f.runtime.store
            .getSnapshot()
            .sessionIndex.find((row) => row.id === sessionId)?.title ===
          "Reviewed workspace",
        "offscreen generated title did not reach sidebar index",
      );
      expect(
        f.runtime.store.getSnapshot().permissionSync.binding?.rootSessionId,
      ).toBe(selected);
    } finally {
      await f.dispose();
    }
  });
});
