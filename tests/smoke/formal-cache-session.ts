/** Interactive controller: all generation enters the real persistent UI backend. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  UiEvent,
  UiPromptCompletion,
  UiCompactSessionResult,
  UiPromptCacheUsage,
} from "ohbaby-sdk";
import {
  createPersistentUiBackendClient,
  closePersistentUiBackendDatabase,
} from "../../packages/ohbaby-agent/src/adapters/ui-persistent.js";
import {
  createLLMClient,
  type TokenUsage,
  type LLMClientInstance,
} from "../../packages/ohbaby-agent/src/core/llm-client/index.js";
import { loadEnvFile } from "../../packages/ohbaby-agent/src/config/llm/loaders.js";
import { reloadLLMConfig } from "../../packages/ohbaby-agent/src/config/llm/index.js";
import { getDatabase } from "../../packages/ohbaby-agent/src/services/database/index.js";
import { readTokenUsageMetadata } from "../../packages/ohbaby-agent/src/core/message/index.js";
import type { RunStatus } from "../../packages/ohbaby-agent/src/runtime/run-ledger/types.js";
import { NATIVE_REAL_PROFILES } from "./reasoning-native-harness.js";
import {
  installFormalCacheObserver,
  type FormalCacheRequestEvidence,
} from "./formal-cache-observer.js";

interface ProviderRequestEvidence {
  id: number;
  purpose?: string;
  sessionId?: string;
  messageCount: number;
  replayStateCount: number;
  exhausted: boolean;
  settled: boolean;
  usage?: TokenUsage;
}

interface PersistedEvidence {
  runs: { status: RunStatus }[];
  usageParts: { partType: string; usage: TokenUsage }[];
}

interface FormalCacheCheckpoint {
  label: string;
  cache: UiPromptCacheUsage;
  messageCount: number;
  answer: {
    sha256: string;
    characters: number;
    project: boolean;
    release: boolean;
    owner: boolean;
  };
  toolCalls: { name: string; status: string }[];
  privateStateVisible: boolean;
  requests: number;
  httpRequests: number;
  persisted: PersistedEvidence;
}

interface FormalCacheSession {
  root: string;
  backend: ReturnType<typeof createPersistentUiBackendClient>;
  providerRequests: ProviderRequestEvidence[];
  wire: FormalCacheRequestEvidence[];
  checkpoints: (
    | FormalCacheCheckpoint
    | { label: string; result: UiCompactSessionResult }
  )[];
  submit(
    text: string,
  ): Promise<{ result: UiPromptCompletion; checkpoint: FormalCacheCheckpoint }>;
  compact(): Promise<{
    before: UiPromptCacheUsage;
    result: UiCompactSessionResult;
    checkpoint: FormalCacheCheckpoint;
  }>;
  changeEffort(
    effort: string,
  ): Promise<{ before: UiPromptCacheUsage; checkpoint: FormalCacheCheckpoint }>;
  checkpoint(label: string): Promise<FormalCacheCheckpoint>;
  status(): Promise<UiPromptCacheUsage>;
  save(path: string): Promise<{ path: string; httpRequests: number }>;
  close(): Promise<void>;
}

export async function createFormalCacheSession(
  profileId: string,
): Promise<FormalCacheSession> {
  const profile = NATIVE_REAL_PROFILES.find((item) => item.id === profileId);
  if (!profile) throw new Error("Unknown verified profile");
  const originalHome = process.env.OHBABY_HOME;
  const originalKey = process.env.ZENMUX_API_KEY;
  const environment: Partial<Record<string, string>> = await loadEnvFile(
    join(process.cwd(), ".env"),
  );
  const key = originalKey ?? environment.ZENMUX_API_KEY;
  if (!key) throw new Error("Missing ZenMux credential");
  process.env.ZENMUX_API_KEY = key;
  const root = await mkdtemp(join(tmpdir(), "ohbaby-formal-cache-"));
  const home = join(root, "config");
  const workdir = join(root, "workspace");
  await mkdir(home);
  await mkdir(workdir);
  await writeFile(
    join(workdir, "cache-note.md"),
    "Project: Cedar\nRelease: 17\nOwner: Lin\nConstraint: read only; no files may be changed.\n",
  );
  process.env.OHBABY_HOME = home;
  const config = {
    provider: "zenmux",
    defaultModel: profile.model,
    apiConfig: {
      baseUrl: profile.baseUrl,
      apiKeyEnv: "ZENMUX_API_KEY",
      interfaceProvider: profile.protocol,
    },
    llmParams: {
      maxTokens: 4096,
      contextWindowTokens: 128000,
      reasoning: { enabled: true, effort: profile.enabledEffort },
    },
    models: [
      {
        model: profile.model,
        interfaceProvider: profile.protocol,
        baseUrl: profile.baseUrl,
        contextWindowTokens: 128000,
        maxOutputTokens: 4096,
        reasoningCapabilities: profile.capabilities,
      },
    ],
  };
  const configPath = join(home, "model.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));
  const context = new AsyncLocalStorage<{ id: number; purpose?: string }>();
  const observer = installFormalCacheObserver({
    maxRequests: 25,
    context: () => context.getStore(),
  });
  const providerRequests: ProviderRequestEvidence[] = [];
  const events: Record<string, number> = {};
  const checkpoints: FormalCacheSession["checkpoints"] = [];
  const completions: unknown[] = [];
  const backend = createPersistentUiBackendClient({
    dbPath: join(root, "session.db"),
    workdir,
    projectDirectory: workdir,
    createLLMClient: async (options): Promise<LLMClientInstance> => {
      const client = await createLLMClient({
        ...options,
        modelJsonPath: configPath,
        env: { ...environment, ...process.env },
      });
      const stream = client.provider.streamResponse.bind(client.provider);
      client.provider.streamResponse = async (
        request,
      ): ReturnType<typeof stream> => {
        const row = {
          id: providerRequests.length + 1,
          purpose: request.purpose,
          sessionId: request.sessionId,
          messageCount: request.messages.length,
          replayStateCount: request.messages.filter(
            (message) =>
              message.role === "assistant" && message.modelState !== undefined,
          ).length,
          exhausted: false,
          settled: false,
          usage: undefined as TokenUsage | undefined,
        };
        providerRequests.push(row);
        const iterable = await context
          .run(row, () => stream(request))
          .catch((error: unknown) => {
            row.settled = true;
            throw error;
          });
        const iterator = iterable[Symbol.asyncIterator]();
        return (async function* (): Awaited<ReturnType<typeof stream>> {
          try {
            for (;;) {
              const next = await context.run(row, () => iterator.next());
              if (next.done) {
                row.exhausted = true;
                break;
              }
              if (next.value.tokenUsage) row.usage = next.value.tokenUsage;
              yield next.value;
            }
          } finally {
            try {
              if (!row.exhausted) await iterator.return?.();
            } finally {
              row.settled = true;
            }
          }
        })();
      };
      return client;
    },
  });
  const unsubscribe = backend.subscribeEvents((event) => {
    events[event.type] = (events[event.type] ?? 0) + 1;
  });
  let sessionId: string | undefined;
  async function status(): Promise<UiPromptCacheUsage> {
    sessionId ??= (await backend.getSnapshot()).activeSessionId ?? undefined;
    if (!sessionId) throw new Error("No session yet");
    const captured: UiEvent[] = [];
    const off = backend.subscribeEvents((event) => {
      if (event.type === "command.result.delivered") captured.push(event);
    });
    try {
      await backend.executeCommand({
        argv: [],
        clientInvocationId: `formal-status-${String(checkpoints.length)}`,
        commandId: "status",
        path: ["status"],
        raw: "/status",
        rawArgs: "",
        sessionId,
        surface: "tui",
      });
    } finally {
      off();
    }
    const result = captured.findLast(
      (event) => event.type === "command.result.delivered",
    );
    if (
      result?.type !== "command.result.delivered" ||
      result.output?.kind !== "data"
    )
      throw new Error("Missing production status result");
    return result.output.data.promptCacheUsage as UiPromptCacheUsage;
  }
  async function checkpoint(label: string): Promise<FormalCacheCheckpoint> {
    await observer.drain();
    const cache = await status();
    const snapshot = await backend.getSnapshot();
    const db = getDatabase();
    // Select only status and usage metadata, never prompt, tool result, or native state content.
    const runs = db
      .prepare<{
        status: RunStatus;
      }>(
        "SELECT status FROM run_ledger WHERE session_id = ? AND context_scope_id IS NULL ORDER BY created_at, run_id",
      )
      .all(cache.sessionId);
    const usageParts = db
      .prepare<{ partType: string; metadata: string }>(
        `SELECT p.type AS partType, json_extract(p.data, '$.metadata') AS metadata
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ? AND m.context_scope_id IS NULL AND m.role = 'assistant'
         AND json_type(p.data, '$.metadata.tokenUsage') = 'object'
       ORDER BY p.created_at, p.message_id, p.order_index`,
      )
      .all(cache.sessionId)
      .flatMap((part) => {
        const usage = readTokenUsageMetadata(
          JSON.parse(part.metadata) as unknown,
        );
        return usage ? [{ partType: part.partType, usage }] : [];
      });
    const session = snapshot.sessions.find((item) => item.id === sessionId);
    const parts = session?.messages.flatMap((message) => message.parts) ?? [];
    const answer =
      session?.messages
        .findLast((message) => message.role === "assistant")
        ?.parts.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n") ?? "";
    const row = {
      label,
      cache,
      persisted: { runs, usageParts },
      messageCount: session?.messages.length ?? 0,
      answer: {
        sha256: createHash("sha256").update(answer).digest("hex"),
        characters: answer.length,
        project: answer.includes("Cedar"),
        release: answer.includes("17"),
        owner: answer.includes("Lin"),
      },
      toolCalls: parts
        .filter((part) => part.type === "tool-call")
        .map((part) => ({ name: part.call.name, status: part.call.status })),
      privateStateVisible: parts.some(
        (part) => (part as { type: string }).type === "model-state",
      ),
      requests: providerRequests.length,
      httpRequests: observer.records.length,
    };
    checkpoints.push(row);
    return row;
  }
  return {
    root,
    backend,
    providerRequests,
    wire: observer.records,
    checkpoints,
    async submit(text: string): ReturnType<FormalCacheSession["submit"]> {
      const result = await backend.submitPromptAndWait(text, {
        ...(sessionId ? { sessionId } : {}),
        signal: AbortSignal.timeout(180000),
      });
      sessionId = result.prompt.sessionId;
      completions.push({
        status: result.prompt.status,
        ...(result.prompt.error
          ? {
              errorCode: result.prompt.error.code,
              statusCode: result.prompt.error.statusCode,
            }
          : {}),
      });
      return {
        result,
        checkpoint: await checkpoint(`run-${String(completions.length)}`),
      };
    },
    async compact(): ReturnType<FormalCacheSession["compact"]> {
      const before = await status();
      const result = await backend.compactSession({ sessionId, force: true });
      checkpoints.push({ label: "compaction-result", result });
      return {
        before,
        result,
        checkpoint: await checkpoint("after-compaction"),
      };
    },
    async changeEffort(
      effort: string,
    ): ReturnType<FormalCacheSession["changeEffort"]> {
      if (profile.protocol === "openai-responses")
        throw new Error(
          "Public connectModel cannot select Responses; no private runtime reset used",
        );
      if (!profile.capabilities.efforts?.includes(effort))
        throw new Error("Unverified effort");
      const before = await status();
      config.llmParams.reasoning.effort = effort;
      await writeFile(configPath, JSON.stringify(config, null, 2));
      await reloadLLMConfig({
        modelJsonPath: configPath,
        env: { ...environment, ...process.env },
        projectDirectory: workdir,
      });
      await backend.connectModel({
        provider: "zenmux",
        model: profile.model,
        interfaceProvider: profile.protocol,
        baseUrl: profile.baseUrl,
        apiKeyEnv: "ZENMUX_API_KEY",
        contextWindowTokens: 128000,
        maxOutputTokens: 4096,
      });
      return { before, checkpoint: await checkpoint(`effort-${effort}`) };
    },
    checkpoint,
    status,
    async save(path: string): ReturnType<FormalCacheSession["save"]> {
      if (providerRequests.some((row) => !row.settled))
        throw new Error("Provider operation still active; evidence not ready");
      await observer.drain();
      if (providerRequests.some((row) => !row.settled))
        throw new Error("Provider operation still active; evidence not ready");
      await writeFile(
        path,
        JSON.stringify(
          {
            profile: profile.id,
            recordedAt: new Date().toISOString(),
            entry: "createPersistentUiBackendClient.submitPromptAndWait",
            productionPrompt: true,
            contextWindowTokens: 128000,
            maxOutputTokens: 4096,
            providerRequests,
            wire: observer.records,
            checkpoints,
            completions,
            events,
          },
          null,
          2,
        ) + "\n",
      );
      return { path, httpRequests: observer.records.length };
    },
    async close(): Promise<void> {
      unsubscribe();
      try {
        await backend.dispose();
        await observer.drain();
      } finally {
        observer.restore();
        closePersistentUiBackendDatabase();
        if (originalHome === undefined) delete process.env.OHBABY_HOME;
        else process.env.OHBABY_HOME = originalHome;
        if (originalKey === undefined) delete process.env.ZENMUX_API_KEY;
        else process.env.ZENMUX_API_KEY = originalKey;
      }
    },
  };
}
