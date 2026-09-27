import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import {
  createPersistentUiBackendClient,
  type LLMClientInstance,
} from "ohbaby-agent";
import { createDaemonServerApp } from "ohbaby-server";
import {
  closeDatabase,
  getDatabase,
} from "../../../../../packages/ohbaby-agent/src/services/database/index.js";
import { createOhbabyWebRuntime } from "../../runtime.js";

const llmClient: LLMClientInstance<{ readonly kind: "fixture" }> = {
  provider: {
    id: "fixture",
    kind: "openai-compatible",
    client: { kind: "fixture" },
    isAbortError: () => false,
    streamResponse: () =>
      Promise.resolve(
        (async function* (): AsyncGenerator<
          { textDelta: string; finishReason: "stop" },
          void,
          unknown
        > {
          yield await Promise.resolve({
            textDelta: "done",
            finishReason: "stop",
          });
        })(),
      ),
  },
  config: {
    provider: "fixture",
    model: "fixture",
    modelProfiles: [
      {
        model: "fixture",
        contextWindowTokens: 128000,
        reasoningCapabilities: {
          mode: "none",
          wire: "none",
          supportsDisabled: true,
        },
      },
    ],
    apiKeyEnv: "FIXTURE_UNUSED",
    baseUrl: "https://example.invalid",
    interfaceProvider: "openai-compatible",
    temperature: 0,
    maxTokens: 128,
  },
};

export interface NewSessionFixture {
  readonly server: ReturnType<typeof createDaemonServerApp>;
  readonly backend: ReturnType<typeof createPersistentUiBackendClient>;
  readonly runtime: ReturnType<typeof createOhbabyWebRuntime>;
  readonly requests: string[];
  readonly workdir: string;
  readonly makeRuntime: (
    clientId: string,
  ) => ReturnType<typeof createOhbabyWebRuntime>;
  readonly count: () => number;
  readonly dispose: () => Promise<void>;
}

export async function fixture(): Promise<NewSessionFixture> {
  vi.stubGlobal("localStorage", undefined);
  const root = await mkdtemp(join(tmpdir(), "ohbaby-new-session-regression-"));
  const workdir = join(root, "workspace");
  await mkdir(workdir);
  vi.stubEnv("OHBABY_HOME", join(root, "home"));
  vi.stubEnv("OHBABY_STORAGE_ROOT", join(root, "storage"));
  const backend = createPersistentUiBackendClient({
    workdir,
    dbPath: join(root, "test.db"),
    enableSnapshots: false,
    llmClient,
    startupSessionMode: { type: "fresh" },
  });
  const server = createDaemonServerApp({
    backend,
    authToken: "fixture-token",
    commandRecorder: false,
  });
  await server.start();
  const requests: string[] = [];
  const fetchImpl: typeof fetch = (input, init = {}) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (init.method === "POST") requests.push(url.pathname);
    return Promise.resolve(
      server.app.request(`${url.pathname}${url.search}`, {
        body: init.body,
        headers: init.headers,
        method: init.method,
        signal: init.signal,
      }),
    );
  };
  const makeRuntime = (
    clientId: string,
  ): ReturnType<typeof createOhbabyWebRuntime> =>
    createOhbabyWebRuntime(
      {
        baseUrl: "http://127.0.0.1:4096",
        clientId,
        directory: workdir,
        startupIntent: { startupSessionMode: { type: "fresh" } },
        token: "fixture-token",
      },
      { fetch: fetchImpl },
    );
  const runtime = makeRuntime("web-regression");
  await runtime.ready;
  return {
    server,
    backend,
    runtime,
    makeRuntime,
    requests,
    workdir,
    count: (): number =>
      getDatabase()
        .prepare<{
          count: number;
        }>("SELECT COUNT(*) AS count FROM session WHERE parent_id IS NULL")
        .get()?.count ?? 0,
    async dispose(): Promise<void> {
      await runtime.dispose();
      await server.dispose();
      await backend.dispose();
      closeDatabase();
      await rm(root, { recursive: true, force: true });
    },
  };
}
