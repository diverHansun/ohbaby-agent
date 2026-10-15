/** Real HTTP daemon + SQLite + lifecycle. Paid provider cases are opt-in. */
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPersistentUiBackendClient,
  closePersistentUiBackendDatabase,
} from "../../../../ohbaby-agent/src/adapters/ui-persistent.js";
import { createInterfaceProvider } from "../../../../ohbaby-agent/src/services/interface-providers/index.js";
import type { LLMClientInstance } from "../../../../ohbaby-agent/src/core/llm-client/types.js";
import type { InterfaceProviderStreamEvent } from "../../../../ohbaby-agent/src/services/interface-providers/types.js";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "../../../../ohbaby-agent/src/core/llm-client/idle-watchdog.js";
import { loadEnvFile } from "../../../../ohbaby-agent/src/config/llm/loaders.js";
import { createDaemonHttpServer } from "./server.js";
import { createRemoteUiBackendClient } from "../../protocols/jsonrpc/client.js";
// Same three protocol/model pairs documented in tests/models-4-tests.md.
const LIVE_PROFILES = [
  {
    protocol: "openai-compatible",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com",
    reasoningCapabilities: {
      mode: "binary",
      wire: "thinking",
      supportsDisabled: true,
    },
  },
  {
    protocol: "openai-responses",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com",
    reasoningCapabilities: {
      mode: "effort",
      wire: "openai",
      efforts: ["high"],
      supportsDisabled: true,
    },
  },
  {
    protocol: "anthropic",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com/anthropic",
    reasoningCapabilities: {
      mode: "effort",
      wire: "anthropic-budget",
      efforts: ["high"],
      budgets: { high: 1024 },
      supportsDisabled: true,
    },
  },
] as const;

async function withDaemon(
  llmClient: LLMClientInstance,
  check: (
    client: ReturnType<typeof createRemoteUiBackendClient>,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(os.tmpdir(), "ohbaby-idle-e2e-"));
  const home = join(root, "home");
  const workdir = join(root, "workspace");
  await mkdir(home);
  await mkdir(workdir);
  await writeFile(join(home, ".skip-auto-migrate"), "");
  vi.stubEnv("OHBABY_HOME", home);
  vi.spyOn(os, "homedir").mockReturnValue(root);
  const backend = createPersistentUiBackendClient({
    dbPath: join(root, "session.db"),
    workdir,
    projectDirectory: workdir,
    llmClient,
    enableSnapshots: false,
  });
  const authToken = randomUUID();
  const server = createDaemonHttpServer({
    backend,
    authToken,
    host: "127.0.0.1",
    port: 0,
  });
  let client: ReturnType<typeof createRemoteUiBackendClient> | undefined;
  try {
    await server.start();
    client = createRemoteUiBackendClient({
      authToken,
      host: "127.0.0.1",
      port: server.port,
    });
    await check(client);
  } finally {
    await client?.dispose();
    await server.stop();
    closePersistentUiBackendDatabase();
    await rm(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("request idle failure through the HTTP daemon", () => {
  it("fails a partially emitted goal run, pauses the goal, and keeps the service usable", async () => {
    // Only accelerate the watchdog's production constant for this fault-injection
    // case. HTTP/RPC, persistence, retry policy and driver stay production code.
    const setTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms, ...args) =>
      setTimer(fn, ms === DEFAULT_STREAM_IDLE_TIMEOUT_MS ? 30 : ms, ...args),
    );
    let calls = 0;
    let providerSignal: AbortSignal | undefined;
    const llmClient: LLMClientInstance = {
      config: {
        provider: "fixture",
        model: "fixture",
        interfaceProvider: "openai-compatible",
        baseUrl: "https://fixture.invalid",
        maxTokens: 128,
        contextWindowTokens: 128000,
      },
      provider: {
        id: "fixture",
        kind: "openai-compatible",
        client: {},
        isAbortError: () => false,
        streamResponse(request) {
          if (request.purpose === "session-title")
            return Promise.resolve(
              (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
                await Promise.resolve();
                yield {
                  textDelta: "Idle fixture",
                  finishReason: "stop" as const,
                };
              })(),
            );
          calls++;
          providerSignal = request.signal;
          return Promise.resolve(
            (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
              yield { textDelta: "partial goal output" };
              await new Promise(() => {
                /* ignores abort; return also remains pending */
              });
            })(),
          );
        },
      },
    };
    await withDaemon(llmClient, async (client) => {
      const session = await client.createSession();
      const command = await client.executeCommand({
        commandId: "goal",
        path: ["goal"],
        clientInvocationId: randomUUID(),
        raw: "/goal Exercise controlled idle failure",
        rawArgs: "Exercise controlled idle failure",
        argv: ["Exercise", "controlled", "idle", "failure"],
        sessionId: session.id,
        surface: "web",
      });
      expect(command.status).toBe("completed");
      let snapshot = await client.getSnapshot();
      const deadline = Date.now() + 10_000;
      while (
        snapshot.goals?.find((row) => row.sessionId === session.id)?.goal
          .status !== "paused" &&
        Date.now() < deadline
      ) {
        await delay(20);
        snapshot = await client.getSnapshot();
      }
      const goal = snapshot.goals?.find(
        (row) => row.sessionId === session.id,
      )?.goal;
      expect(goal?.status).toBe("paused");
      expect(goal?.pauseReason).toContain("runtime error:");
      expect(
        snapshot.runs.some(
          (run) => run.sessionId === session.id && run.status.kind === "error",
        ),
      ).toBe(true);
      expect(providerSignal?.aborted).toBe(true);
      expect(calls).toBe(1);
      expect((await client.createSession()).id).not.toBe(session.id);
    });
  });
});

const live = process.env.OHBABY_RUN_IDLE_REAL_E2E === "1" ? it : it.skip;
describe("live provider through HTTP daemon", () => {
  live.each(LIVE_PROFILES)(
    "completes a real $protocol request with the watchdog enabled",
    async (profile) => {
      const env = await loadEnvFile(join(process.cwd(), ".env"));
      const apiKey = process.env.DEEPSEEK_API_KEY ?? env.DEEPSEEK_API_KEY;
      if (!apiKey)
        throw new Error("DEEPSEEK_API_KEY is required for this opt-in test");
      const provider = createInterfaceProvider({
        id: "deepseek",
        interfaceProvider: profile.protocol,
        apiKey,
        baseUrl: profile.baseUrl,
      });
      let calls = 0;
      const open = provider.streamResponse.bind(provider);
      provider.streamResponse = (request): ReturnType<typeof open> => {
        if (++calls > 4) throw new Error("Real E2E request cap reached");
        return open(request);
      };
      const llmClient: LLMClientInstance = {
        provider,
        config: {
          provider: "deepseek",
          model: profile.model,
          interfaceProvider: profile.protocol,
          baseUrl: profile.baseUrl,
          maxTokens: 2048,
          contextWindowTokens: 128000,
          reasoning: { enabled: false },
          modelProfiles: [
            {
              model: profile.model,
              contextWindowTokens: 128000,
              reasoningCapabilities: profile.reasoningCapabilities,
            },
          ],
        },
      };
      await withDaemon(llmClient, async (client) => {
        const session = await client.createSession();
        const result = await client.submitPromptAndWait(
          "Reply exactly IDLE_WATCHDOG_LIVE_OK. Do not use tools or create a goal.",
          {
            sessionId: session.id,
            signal: AbortSignal.timeout(90_000),
          },
        );
        const failure =
          result.prompt.status === "failed"
            ? result.prompt.error.message.replaceAll(apiKey, "[redacted]")
            : undefined;
        expect(result.prompt.status, failure).toBe("succeeded");
        const snapshot = await client.getSnapshot();
        const messages = snapshot.sessions.find(
          (row) => row.id === session.id,
        )?.messages;
        expect(
          JSON.stringify(
            messages?.filter((message) => message.role === "assistant"),
          ),
        ).toContain("IDLE_WATCHDOG_LIVE_OK");
        expect(calls).toBeGreaterThan(0);
        expect(calls).toBeLessThanOrEqual(4);
      });
    },
  );
});
