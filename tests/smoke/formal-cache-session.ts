/** Interactive controller: all generation enters the real persistent UI backend. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  UiEvent,
  UiPromptCompletion,
  UiCompactSessionResult,
  UiPromptCacheUsage,
  UiContextWindowUsage,
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
import { probeActiveModelContextWindow } from "../../packages/ohbaby-agent/src/config/llm/apply-active-model-config.js";
import { getDatabase } from "../../packages/ohbaby-agent/src/services/database/index.js";
import { readTokenUsageMetadata } from "../../packages/ohbaby-agent/src/core/message/index.js";
import type { RunStatus } from "../../packages/ohbaby-agent/src/runtime/run-ledger/types.js";
import { NATIVE_REAL_PROFILES } from "./reasoning-native-harness.js";
import { LIVE_CONTEXT_PROFILES } from "./formal-cache-live-context.js";
import {
  classifyControlledRead,
  decideControlledPermission,
  type ControlledReadDecision,
} from "./formal-cache-live-context.js";
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
  replayStateHashes: string[];
  exhausted: boolean;
  settled: boolean;
  usage?: TokenUsage;
}

interface PersistedEvidence {
  completedTools: ControlledReadDecision[];
  runs: { status: RunStatus }[];
  usageParts: { partType: string; usage: TokenUsage }[];
  context: {
    summaryParts: number;
    summaryCharacters: number;
    retiredParts: number;
    retiredNativeParts: number;
    activeNativeParts: number;
  };
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
  readFilePath: string;
  contextWindow: { tokens: number; source: "detected" | "legacy" };
  backend: ReturnType<typeof createPersistentUiBackendClient>;
  providerRequests: ProviderRequestEvidence[];
  contextUpdates: UiContextWindowUsage[];
  nativeFingerprints: { label: string; count: number; sha256: string }[];
  nativeSnapshots: { label: string; active: string[]; retired: string[] }[];
  permissionDecisions: ControlledReadDecision[];
  permissionErrors: string[];
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
  reopen(): Promise<void>;
  activeNativeFingerprint(label?: string): { count: number; sha256: string };
  nativeStateHashes(label?: string): { active: string[]; retired: string[] };
  allToolPartIds(): { ids: string[] };
}

export async function createFormalCacheSession(
  profileId: string,
  options: { requireDetectedWindow?: boolean; maxRequests?: number } = {},
): Promise<FormalCacheSession> {
  const profile = [...NATIVE_REAL_PROFILES, ...LIVE_CONTEXT_PROFILES].find(
    (item) => item.id === profileId,
  );
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
  const readFilePath = join(workdir, "cache-note.md");
  await mkdir(home);
  await mkdir(workdir);
  await writeFile(
    readFilePath,
    "Project: Cedar\nRelease: 17\nOwner: Lin\nConstraint: read only; no files may be changed.\n",
  );
  process.env.OHBABY_HOME = home;
  const context = new AsyncLocalStorage<{ id: number; purpose?: string }>();
  const observer = installFormalCacheObserver({
    maxRequests: options.maxRequests ?? 25,
    context: () => context.getStore(),
  });
  let contextWindow: FormalCacheSession["contextWindow"] = {
    tokens: 128000,
    source: "legacy",
  };
  if (options.requireDetectedWindow) {
    try {
      const probe = await probeActiveModelContextWindow({
        apiKey: key,
        baseUrl: profile.baseUrl,
        interfaceProvider: profile.protocol,
        model: profile.model,
      });
      if (probe.contextWindowSource !== "detected")
        throw new Error(
          "A detected context window is required for live context E2E",
        );
      contextWindow = { tokens: probe.contextWindowTokens, source: "detected" };
    } catch (error) {
      observer.restore();
      if (originalHome === undefined) delete process.env.OHBABY_HOME;
      else process.env.OHBABY_HOME = originalHome;
      if (originalKey === undefined) delete process.env.ZENMUX_API_KEY;
      else process.env.ZENMUX_API_KEY = originalKey;
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
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
      contextWindowTokens: contextWindow.tokens,
      reasoning: { enabled: true, effort: profile.enabledEffort },
    },
    models: [
      {
        model: profile.model,
        interfaceProvider: profile.protocol,
        baseUrl: profile.baseUrl,
        contextWindowTokens: contextWindow.tokens,
        maxOutputTokens: 4096,
        reasoningCapabilities: profile.capabilities,
      },
    ],
  };
  const configPath = join(home, "model.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));
  const providerRequests: ProviderRequestEvidence[] = [];
  const contextUpdates: UiContextWindowUsage[] = [];
  const nativeFingerprints: FormalCacheSession["nativeFingerprints"] = [];
  const nativeSnapshots: FormalCacheSession["nativeSnapshots"] = [];
  const permissionDecisions: ControlledReadDecision[] = [];
  const permissionErrors: string[] = [];
  const pendingPermissions = new Set<Promise<void>>();
  const events: Record<string, number> = {};
  const checkpoints: FormalCacheSession["checkpoints"] = [];
  const completions: unknown[] = [];
  function newBackend(): ReturnType<typeof createPersistentUiBackendClient> {
    return createPersistentUiBackendClient({
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
                message.role === "assistant" &&
                message.modelState !== undefined,
            ).length,
            replayStateHashes: request.messages
              .flatMap((message) =>
                message.role === "assistant" && message.modelState
                  ? [hashState(message.modelState)]
                  : [],
              )
              .sort(),
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
  }
  let backend = newBackend();
  async function handlePermission(
    request: Extract<UiEvent, { type: "permission.requested" }>["request"],
  ): Promise<void> {
    let decision = classifyControlledRead(undefined, workdir, readFilePath);
    let choiceId: string | undefined;
    try {
      const selection = decideControlledPermission(
        request,
        await backend.getSnapshot(),
        workdir,
        readFilePath,
      );
      decision = selection.decision;
      choiceId = selection.choiceId;
    } catch {
      permissionErrors.push("PERMISSION_CLASSIFICATION_FAILED");
      choiceId = request.choices.find(
        (choice) => choice.intent === "deny" || choice.intent === "abort",
      )?.id;
    }
    permissionDecisions.push(decision);
    if (!choiceId) {
      permissionErrors.push("NO_DENY_CHOICE");
      await backend.abortRun(request.runId);
      return;
    }
    try {
      await backend.respondPermission(request.id, {
        choiceId,
        remember: false,
      });
    } catch {
      permissionErrors.push("PERMISSION_RESPONSE_FAILED");
      await backend.abortRun(request.runId);
    }
  }
  const onEvent = (event: UiEvent): void => {
    events[event.type] = (events[event.type] ?? 0) + 1;
    if (event.type === "context.window.updated")
      contextUpdates.push(event.usage);
    if (
      options.requireDetectedWindow &&
      event.type === "permission.requested"
    ) {
      const task = handlePermission(event.request).catch(() => {
        permissionErrors.push("PERMISSION_HANDLER_FAILED");
      });
      pendingPermissions.add(task);
      void task.finally(() => pendingPermissions.delete(task));
    }
  };
  let unsubscribe = backend.subscribeEvents(onEvent);
  let sessionId: string | undefined;
  function activeNativeFingerprint(label = "snapshot"): {
    count: number;
    sha256: string;
  } {
    if (!sessionId) throw new Error("No session yet");
    const rows = getDatabase()
      .prepare<{ id: string; data: string }>(
        `SELECT p.id, p.data FROM part p JOIN message m ON m.id = p.message_id
         WHERE p.session_id = ? AND m.context_scope_id IS NULL
           AND p.type = 'model-state'
           AND json_extract(p.data, '$.time.compacted') IS NULL
         ORDER BY p.created_at, p.message_id, p.order_index`,
      )
      .all(sessionId);
    const fingerprint = {
      count: rows.length,
      sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    };
    nativeFingerprints.push({ label, ...fingerprint });
    return fingerprint;
  }
  function allToolPartIds(): { ids: string[] } {
    if (!sessionId) throw new Error("No session yet");
    const rows = getDatabase()
      .prepare<{ id: string }>(
        `SELECT p.id FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ? AND m.context_scope_id IS NULL AND p.type = 'tool'
       ORDER BY p.id`,
      )
      .all(sessionId);
    return { ids: rows.map((row) => row.id) };
  }
  function nativeStateHashes(label = "snapshot"): {
    active: string[];
    retired: string[];
  } {
    if (!sessionId) throw new Error("No session yet");
    const rows = getDatabase()
      .prepare<{ state: string; retired: number }>(
        `SELECT json_extract(p.data, '$.modelState') AS state,
        json_extract(p.data, '$.time.compacted') IS NOT NULL AS retired
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ? AND m.context_scope_id IS NULL AND p.type = 'model-state'`,
      )
      .all(sessionId);
    const result = { active: [] as string[], retired: [] as string[] };
    for (const row of rows) {
      result[row.retired ? "retired" : "active"].push(
        hashState(JSON.parse(row.state) as unknown),
      );
    }
    result.active.sort();
    result.retired.sort();
    nativeSnapshots.push({ label, ...result });
    return result;
  }
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
    // Include retired tools and calls that never needed a permission prompt.
    // Only hashes and the controlled-path verdict leave this process.
    const completedTools = db
      .prepare<{ name: string; input: string }>(
        `SELECT json_extract(p.data, '$.tool') AS name,
          json_extract(p.data, '$.state.input') AS input
         FROM part p JOIN message m ON m.id = p.message_id
         WHERE p.session_id = ? AND m.context_scope_id IS NULL
           AND p.type = 'tool' AND json_extract(p.data, '$.state.status') = 'completed'
         ORDER BY p.id`,
      )
      .all(cache.sessionId)
      .map((tool) =>
        classifyControlledRead(
          {
            name: tool.name,
            input: JSON.parse(tool.input) as Record<string, unknown>,
          },
          workdir,
          readFilePath,
        ),
      );
    const contextEvidence = db
      .prepare<PersistedEvidence["context"]>(
        `SELECT
          COALESCE(SUM(CASE WHEN p.type = 'text' AND json_extract(p.data, '$.metadata.kind') = 'context-summary' THEN 1 ELSE 0 END), 0) AS summaryParts,
          COALESCE(SUM(CASE WHEN p.type = 'text' AND json_extract(p.data, '$.metadata.kind') = 'context-summary' THEN length(json_extract(p.data, '$.text')) ELSE 0 END), 0) AS summaryCharacters,
          COALESCE(SUM(CASE WHEN json_extract(p.data, '$.time.compacted') IS NOT NULL THEN 1 ELSE 0 END), 0) AS retiredParts,
          COALESCE(SUM(CASE WHEN p.type = 'model-state' AND json_extract(p.data, '$.time.compacted') IS NOT NULL THEN 1 ELSE 0 END), 0) AS retiredNativeParts,
          COALESCE(SUM(CASE WHEN p.type = 'model-state' AND json_extract(p.data, '$.time.compacted') IS NULL THEN 1 ELSE 0 END), 0) AS activeNativeParts
         FROM part p JOIN message m ON m.id = p.message_id
         WHERE p.session_id = ? AND m.context_scope_id IS NULL`,
      )
      .get(cache.sessionId);
    if (!contextEvidence) throw new Error("Missing persisted context evidence");
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
      persisted: { runs, usageParts, context: contextEvidence, completedTools },
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
    readFilePath,
    contextWindow,
    get backend(): ReturnType<typeof createPersistentUiBackendClient> {
      return backend;
    },
    providerRequests,
    contextUpdates,
    nativeFingerprints,
    nativeSnapshots,
    permissionDecisions,
    permissionErrors,
    wire: observer.records,
    checkpoints,
    async submit(text: string): ReturnType<FormalCacheSession["submit"]> {
      const result = await backend.submitPromptAndWait(text, {
        ...(sessionId ? { sessionId } : {}),
        signal: AbortSignal.timeout(180000),
      });
      await Promise.all([...pendingPermissions]);
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
        contextWindowTokens: contextWindow.tokens,
        maxOutputTokens: 4096,
      });
      return { before, checkpoint: await checkpoint(`effort-${effort}`) };
    },
    checkpoint,
    status,
    activeNativeFingerprint,
    nativeStateHashes,
    allToolPartIds,
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
            contextWindowTokens: contextWindow.tokens,
            contextWindowSource: contextWindow.source,
            maxOutputTokens: 4096,
            providerRequests,
            contextUpdates,
            nativeFingerprints,
            nativeSnapshots,
            permissionDecisions,
            permissionErrors,
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
    async reopen(): Promise<void> {
      if (providerRequests.some((row) => !row.settled))
        throw new Error("Provider operation still active; cannot reopen");
      await observer.drain();
      unsubscribe();
      await backend.dispose();
      closePersistentUiBackendDatabase();
      backend = newBackend();
      unsubscribe = backend.subscribeEvents(onEvent);
      const reopened = await backend.getSnapshot();
      if (sessionId && !reopened.sessions.some((item) => item.id === sessionId))
        throw new Error("Reopened backend lost the original session");
    },
  };
}

/** Sort object keys so durable JSON and request objects hash identically. */
function hashState(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => [key, canonical(nested)]),
      );
    return item;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
